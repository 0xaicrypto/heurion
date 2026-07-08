"""
BscQueryTool — Direct read-only BSC chain queries via Web3 RPC.

Why this exists: when users ask "what's the current BSC block height" or
"what's this address' BNB balance", the LLM was previously falling back
to web_search + bscscan.com scraping, which is unreliable (Tavily often
returns Bitcoin block height by mistake, and bscscan HTML changes
frequently). Going direct to a BSC RPC endpoint gives us:

  * Authoritative answers — same data Bscscan itself reads
  * No HTML scraping fragility
  * Sub-second latency for hot queries
  * Works whether or not the user has a private key configured

The tool is read-only by design — sending transactions belongs to the
twin's chain backend, not an LLM-callable surface (we never want a
hallucinated query to drain a hot wallet).

Configure via env (with sensible defaults):
  BSC_RPC_MAINNET=https://bsc-dataseed.binance.org/
  BSC_RPC_TESTNET=https://data-seed-prebsc-1-s1.binance.org:8545/

`network` parameter on each call defaults to `mainnet` since "what's the
current block height" almost always means production.
"""

from __future__ import annotations

import logging
import os
from typing import Optional

from .base import BaseTool, ToolResult

logger = logging.getLogger(__name__)


# Public RPC endpoints. Both Binance-operated and free of charge for
# read traffic; well within the rate limits a chat agent generates.
DEFAULT_BSC_MAINNET_RPC = "https://bsc-dataseed.binance.org/"
DEFAULT_BSC_TESTNET_RPC = "https://data-seed-prebsc-1-s1.binance.org:8545/"


class BscQueryTool(BaseTool):
    """Read-only BSC chain query tool — block number, balance, tx receipt."""

    def __init__(
        self,
        mainnet_rpc: Optional[str] = None,
        testnet_rpc: Optional[str] = None,
    ):
        self._mainnet_rpc = (
            mainnet_rpc
            or os.environ.get("BSC_RPC_MAINNET")
            or DEFAULT_BSC_MAINNET_RPC
        )
        self._testnet_rpc = (
            testnet_rpc
            or os.environ.get("BSC_RPC_TESTNET")
            or DEFAULT_BSC_TESTNET_RPC
        )
        # Lazy: import web3 + connect on first call so a missing web3
        # install doesn't block twin startup. The SDK already requires
        # web3 elsewhere, but this keeps the tool self-contained.
        self._w3_mainnet = None
        self._w3_testnet = None

    @property
    def name(self) -> str:
        return "bsc_query"

    @property
    def description(self) -> str:
        return (
            "Query the Binance Smart Chain (BSC) directly via RPC. Use this — "
            "NEVER web_search — for any question about BSC's live state: "
            "current block number, an address' BNB balance, a transaction "
            "receipt or a transaction's block. Returns authoritative data "
            "from a Binance-operated RPC node. Defaults to mainnet; pass "
            "network='testnet' for the BSC testnet."
        )

    @property
    def parameters(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": [
                        "block_number",
                        "balance",
                        "tx_receipt",
                        "block",
                        "code",
                    ],
                    "description": (
                        "Which query to run. "
                        "block_number → latest block height. "
                        "balance → BNB balance of an address (requires `address`). "
                        "tx_receipt → status + gas used + block of a tx (requires `tx_hash`). "
                        "block → timestamp + tx count of a block (requires `block` number or 'latest'). "
                        "code → contract bytecode at an address (requires `address`)."
                    ),
                },
                "network": {
                    "type": "string",
                    "enum": ["mainnet", "testnet"],
                    "description": "BSC network. Default: mainnet.",
                },
                "address": {
                    "type": "string",
                    "description": "0x-prefixed account or contract address (for balance / code).",
                },
                "tx_hash": {
                    "type": "string",
                    "description": "0x-prefixed transaction hash (for tx_receipt).",
                },
                "block": {
                    "type": "string",
                    "description": "Block number or 'latest' / 'finalized' (for block).",
                },
            },
            "required": ["action"],
        }

    # ── Internal: lazy Web3 setup ─────────────────────────────────────

    def _w3(self, network: str):
        """Get a connected Web3 instance for the given network."""
        try:
            from web3 import Web3  # type: ignore
        except ImportError as e:
            raise RuntimeError(
                "web3 package not installed; install nexus_core extras",
            ) from e

        if network == "testnet":
            if self._w3_testnet is None:
                self._w3_testnet = Web3(Web3.HTTPProvider(self._testnet_rpc))
                # BSC is PoA — middleware needed for extraData parsing.
                try:
                    from web3.middleware import ExtraDataToPOAMiddleware
                    self._w3_testnet.middleware_onion.inject(
                        ExtraDataToPOAMiddleware, layer=0,
                    )
                except Exception as exc:
                    logger.debug("PoA middleware injection failed: %s", exc)
            return self._w3_testnet
        # mainnet (default)
        if self._w3_mainnet is None:
            self._w3_mainnet = Web3(Web3.HTTPProvider(self._mainnet_rpc))
            try:
                from web3.middleware import ExtraDataToPOAMiddleware
                self._w3_mainnet.middleware_onion.inject(
                    ExtraDataToPOAMiddleware, layer=0,
                )
            except Exception as exc:
                logger.debug("PoA middleware injection failed: %s", exc)
        return self._w3_mainnet

    # ── Public surface ────────────────────────────────────────────────

    async def execute(
        self,
        action: str = "",
        network: str = "mainnet",
        address: str = "",
        tx_hash: str = "",
        block: str = "",
        **kwargs,
    ) -> ToolResult:
        # Map enum → handler. Failures bubble up as ToolResult(success=False)
        # with the underlying exception text — the LLM can parse "RPC
        # timeout" / "address malformed" / etc and self-correct.
        net = "testnet" if network == "testnet" else "mainnet"
        try:
            w3 = self._w3(net)
            if not w3.is_connected():
                return ToolResult(
                    success=False,
                    error=f"BSC {net} RPC not reachable",
                )

            if action == "block_number":
                n = w3.eth.block_number
                return ToolResult(
                    output=f"BSC {net} latest block: {n:,} (height {n})",
                )

            if action == "balance":
                if not address:
                    return ToolResult(
                        success=False,
                        error="balance requires `address` parameter",
                    )
                from web3 import Web3 as _W3  # type: ignore
                addr = _W3.to_checksum_address(address)
                wei = w3.eth.get_balance(addr)
                bnb = w3.from_wei(wei, "ether")
                return ToolResult(
                    output=f"{addr} balance on BSC {net}: {bnb:.6f} BNB ({wei:,} wei)",
                )

            if action == "tx_receipt":
                if not tx_hash:
                    return ToolResult(
                        success=False,
                        error="tx_receipt requires `tx_hash` parameter",
                    )
                receipt = w3.eth.get_transaction_receipt(tx_hash)
                if receipt is None:
                    return ToolResult(
                        success=False,
                        error=f"tx {tx_hash} not found on BSC {net} (may be pending)",
                    )
                status = "success" if receipt.status == 1 else "reverted"
                return ToolResult(
                    output=(
                        f"BSC {net} tx {tx_hash}\n"
                        f"  status: {status}\n"
                        f"  block:  {receipt.blockNumber:,}\n"
                        f"  gas:    {receipt.gasUsed:,} ({receipt.effectiveGasPrice} wei/gas)\n"
                        f"  from:   {receipt['from']}\n"
                        f"  to:     {receipt.get('to')}\n"
                        f"  logs:   {len(receipt.logs)} event(s)"
                    ),
                )

            if action == "block":
                target = block or "latest"
                if target.isdigit():
                    target = int(target)
                blk = w3.eth.get_block(target)
                return ToolResult(
                    output=(
                        f"BSC {net} block {blk.number:,}\n"
                        f"  hash:      {blk.hash.hex()}\n"
                        f"  timestamp: {blk.timestamp} "
                        f"({_iso(blk.timestamp)})\n"
                        f"  txs:       {len(blk.transactions)}\n"
                        f"  miner:     {blk.miner}"
                    ),
                )

            if action == "code":
                if not address:
                    return ToolResult(
                        success=False,
                        error="code requires `address` parameter",
                    )
                from web3 import Web3 as _W3  # type: ignore
                addr = _W3.to_checksum_address(address)
                code = w3.eth.get_code(addr)
                if not code or code == b"\x00" or code == b"":
                    return ToolResult(
                        output=f"{addr} on BSC {net}: EOA (not a contract)",
                    )
                return ToolResult(
                    output=(
                        f"{addr} on BSC {net}: contract "
                        f"({len(code):,} bytes of bytecode)"
                    ),
                )

            return ToolResult(
                success=False,
                error=f"unknown action: {action!r}; "
                      "use one of block_number / balance / tx_receipt / block / code",
            )
        except Exception as e:  # noqa: BLE001
            logger.debug("bsc_query(%s) failed: %s", action, e)
            return ToolResult(
                success=False,
                error=f"BSC RPC error ({net}): {e}",
            )


def _iso(ts: int) -> str:
    """ISO-format a unix timestamp (UTC) for human display."""
    import datetime as _dt
    return _dt.datetime.utcfromtimestamp(ts).strftime("%Y-%m-%dT%H:%M:%SZ")
