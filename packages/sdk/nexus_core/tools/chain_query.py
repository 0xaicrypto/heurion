"""
ChainQueryTool — multi-chain read-only EVM JSON-RPC queries.

Sister tool to BscQueryTool. Covers the rest of the popular EVM chains
(Ethereum, Polygon, Arbitrum, Optimism, Base) so the LLM can answer
"what's Ethereum's gas price" / "this address' MATIC balance" / "tx
status on Arbitrum" without going through web_search → guess → fail.

Non-EVM chains (Starknet, Solana, Cosmos…) deliberately NOT covered —
they need different RPC dialects. Agent should manage_mcp(search='<chain>')
for those, install the matching MCP server (the curated catalog has
mcp-server-starknet, mcp-server-solana, etc.), and use it.

Configure via env (sensible public defaults preloaded):
  ETHEREUM_RPC=https://eth.llamarpc.com
  POLYGON_RPC=https://polygon-rpc.com
  ARBITRUM_RPC=https://arb1.arbitrum.io/rpc
  OPTIMISM_RPC=https://mainnet.optimism.io
  BASE_RPC=https://mainnet.base.org

All endpoints are public, no auth, no rate-limit issues for normal chat
volume. Override with paid endpoints (Alchemy / Infura / Quicknode) if
you hit limits.
"""

from __future__ import annotations

import logging
import os
from typing import Optional

from .base import BaseTool, ToolResult

logger = logging.getLogger(__name__)


# ── Network presets ──────────────────────────────────────────────────
#
# Map "ethereum" → (rpc_url, chain_id, native_token, explorer_url).
# Explorer URL is for hint links in error messages; we never *scrape*
# it — that's web_search's failure mode and what this whole tool exists
# to avoid.

_PRESETS: dict[str, dict] = {
    "ethereum": {
        "rpc":      "https://eth.llamarpc.com",
        "chain_id": 1,
        "token":    "ETH",
        "explorer": "https://etherscan.io",
        "name":     "Ethereum mainnet",
    },
    "polygon": {
        "rpc":      "https://polygon-rpc.com",
        "chain_id": 137,
        "token":    "MATIC",
        "explorer": "https://polygonscan.com",
        "name":     "Polygon mainnet",
    },
    "arbitrum": {
        "rpc":      "https://arb1.arbitrum.io/rpc",
        "chain_id": 42161,
        "token":    "ETH",
        "explorer": "https://arbiscan.io",
        "name":     "Arbitrum One",
    },
    "optimism": {
        "rpc":      "https://mainnet.optimism.io",
        "chain_id": 10,
        "token":    "ETH",
        "explorer": "https://optimistic.etherscan.io",
        "name":     "OP Mainnet",
    },
    "base": {
        "rpc":      "https://mainnet.base.org",
        "chain_id": 8453,
        "token":    "ETH",
        "explorer": "https://basescan.org",
        "name":     "Base mainnet",
    },
}


def _resolve_rpc(network: str) -> tuple[Optional[dict], Optional[str]]:
    """Look up preset + env override. Returns (preset, error_msg)."""
    network = (network or "").lower().strip()
    if network not in _PRESETS:
        return None, (
            f"unsupported network {network!r}; "
            f"use one of: {', '.join(_PRESETS.keys())}. "
            "For BSC use the bsc_query tool. For Starknet/Solana/etc, "
            "manage_mcp(search='<chain>') and install the matching server."
        )
    preset = dict(_PRESETS[network])  # copy so env override doesn't mutate the table
    env_var = f"{network.upper()}_RPC"
    if env_var in os.environ and os.environ[env_var]:
        preset["rpc"] = os.environ[env_var]
    return preset, None


class ChainQueryTool(BaseTool):
    """Read-only multi-chain EVM JSON-RPC queries (Ethereum / Polygon /
    Arbitrum / Optimism / Base).

    BSC is intentionally NOT included here — it has its own bsc_query
    tool that the LLM is already tuned to. Non-EVM chains require an
    MCP server (see curated catalog).
    """

    def __init__(self):
        # Lazy Web3 instances per network.
        self._w3: dict[str, object] = {}

    @property
    def name(self) -> str:
        return "chain_query"

    @property
    def description(self) -> str:
        return (
            "Read-only EVM JSON-RPC queries for Ethereum, Polygon, "
            "Arbitrum, Optimism, and Base. Returns authoritative chain "
            "data direct from each network's RPC node — never scraped, "
            "never search-engine-mediated.\n"
            "\n"
            "MUST USE this tool — NOT web_search — for any of these "
            "chains' live data. web_search will return stale snippets "
            "or confuse chains.\n"
            "\n"
            "For BSC, use bsc_query instead. For non-EVM chains "
            "(Starknet, Solana, …), call manage_mcp(action='search', "
            "query='<chain>') to install the matching MCP server.\n"
            "\n"
            "Actions:\n"
            "  block_number — latest block height. Needs `network`.\n"
            "  balance      — native token balance. Needs `network` + `address`.\n"
            "  tx_receipt   — tx status / gas / block. Needs `network` + `tx_hash`.\n"
            "  block        — block header info. Needs `network` + `block` "
            "(number or 'latest').\n"
            "  code         — bytecode at address. Needs `network` + `address`."
        )

    @property
    def parameters(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["block_number", "balance", "tx_receipt",
                             "block", "code"],
                    "description": "Which RPC action to run.",
                },
                "network": {
                    "type": "string",
                    "enum": list(_PRESETS.keys()),
                    "description": (
                        "Which EVM chain. ethereum=mainnet, "
                        "polygon=mainnet, arbitrum=Arbitrum One, "
                        "optimism=OP Mainnet, base=Base mainnet. "
                        "(BSC is on bsc_query.)"
                    ),
                },
                "address": {
                    "type": "string",
                    "description": "0x-prefixed address (balance / code).",
                },
                "tx_hash": {
                    "type": "string",
                    "description": "0x-prefixed tx hash (tx_receipt).",
                },
                "block": {
                    "type": "string",
                    "description": "Block number or 'latest' / 'finalized'.",
                },
            },
            "required": ["action", "network"],
        }

    # ── Internal: lazy Web3 setup ─────────────────────────────────────

    def _get_w3(self, preset: dict):
        try:
            from web3 import Web3  # type: ignore
        except ImportError as e:
            raise RuntimeError("web3 package not installed") from e

        rpc = preset["rpc"]
        if rpc not in self._w3:
            w3 = Web3(Web3.HTTPProvider(rpc))
            # PoA middleware for Polygon / Arbitrum / Optimism / Base —
            # they all have non-standard extraData that the default
            # block parser chokes on. Mainnet Ethereum doesn't need it
            # but injecting is harmless.
            try:
                from web3.middleware import ExtraDataToPOAMiddleware
                w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)
            except Exception as exc:
                logger.debug("PoA middleware injection failed: %s", exc)
            self._w3[rpc] = w3
        return self._w3[rpc]

    # ── Public surface ────────────────────────────────────────────────

    async def execute(
        self,
        action: str = "",
        network: str = "ethereum",
        address: str = "",
        tx_hash: str = "",
        block: str = "",
        **kwargs,
    ) -> ToolResult:
        preset, err = _resolve_rpc(network)
        if err:
            return ToolResult(success=False, error=err)
        net_label = preset["name"]
        token = preset["token"]
        try:
            w3 = self._get_w3(preset)
            if not w3.is_connected():
                return ToolResult(
                    success=False,
                    error=f"{net_label} RPC not reachable ({preset['rpc']})",
                )

            if action == "block_number":
                n = w3.eth.block_number
                return ToolResult(
                    output=f"{net_label} latest block: {n:,} (height {n})",
                )

            if action == "balance":
                if not address:
                    return ToolResult(success=False,
                                      error="balance requires `address`")
                from web3 import Web3 as _W3  # type: ignore
                addr = _W3.to_checksum_address(address)
                wei = w3.eth.get_balance(addr)
                native = w3.from_wei(wei, "ether")
                return ToolResult(
                    output=(
                        f"{addr} on {net_label}: "
                        f"{native:.6f} {token} ({wei:,} wei)"
                    ),
                )

            if action == "tx_receipt":
                if not tx_hash:
                    return ToolResult(success=False,
                                      error="tx_receipt requires `tx_hash`")
                receipt = w3.eth.get_transaction_receipt(tx_hash)
                if receipt is None:
                    return ToolResult(
                        success=False,
                        error=f"tx {tx_hash} not found on {net_label} (may be pending)",
                    )
                status = "success" if receipt.status == 1 else "reverted"
                return ToolResult(
                    output=(
                        f"{net_label} tx {tx_hash}\n"
                        f"  status: {status}\n"
                        f"  block:  {receipt.blockNumber:,}\n"
                        f"  gas:    {receipt.gasUsed:,}\n"
                        f"  from:   {receipt['from']}\n"
                        f"  to:     {receipt.get('to')}\n"
                        f"  logs:   {len(receipt.logs)} event(s)\n"
                        f"  view:   {preset['explorer']}/tx/{tx_hash}"
                    ),
                )

            if action == "block":
                target = block or "latest"
                if target.isdigit():
                    target = int(target)
                blk = w3.eth.get_block(target)
                return ToolResult(
                    output=(
                        f"{net_label} block {blk.number:,}\n"
                        f"  hash:      {blk.hash.hex()}\n"
                        f"  timestamp: {blk.timestamp} ({_iso(blk.timestamp)})\n"
                        f"  txs:       {len(blk.transactions)}\n"
                        f"  miner:     {blk.miner}"
                    ),
                )

            if action == "code":
                if not address:
                    return ToolResult(success=False,
                                      error="code requires `address`")
                from web3 import Web3 as _W3  # type: ignore
                addr = _W3.to_checksum_address(address)
                code = w3.eth.get_code(addr)
                if not code or code == b"\x00" or code == b"":
                    return ToolResult(
                        output=f"{addr} on {net_label}: EOA (not a contract)",
                    )
                return ToolResult(
                    output=(
                        f"{addr} on {net_label}: contract "
                        f"({len(code):,} bytes of bytecode)"
                    ),
                )

            return ToolResult(
                success=False,
                error=f"unknown action {action!r}; "
                      "block_number / balance / tx_receipt / block / code",
            )
        except Exception as e:  # noqa: BLE001
            logger.debug("chain_query(%s, %s) failed: %s", action, network, e)
            return ToolResult(
                success=False,
                error=f"{net_label} RPC error: {e}",
            )


def _iso(ts: int) -> str:
    import datetime as _dt
    return _dt.datetime.utcfromtimestamp(ts).strftime("%Y-%m-%dT%H:%M:%SZ")
