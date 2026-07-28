"""Object storage upload helpers for plugin containers."""

import os
import logging
from typing import BinaryIO

logger = logging.getLogger("plugin-server.storage")

_S3_CLIENT = None


def get_s3_client():
    """Return a lazily-initialized boto3 S3 client."""
    global _S3_CLIENT
    if _S3_CLIENT is not None:
        return _S3_CLIENT

    import boto3
    from botocore.config import Config

    endpoint = os.environ.get("S3_ENDPOINT", "")
    region = os.environ.get("S3_REGION", "us-east-1")
    access_key = os.environ.get("S3_ACCESS_KEY_ID", "")
    secret_key = os.environ.get("S3_SECRET_ACCESS_KEY", "")

    if not endpoint or not access_key or not secret_key:
        raise RuntimeError("S3_ENDPOINT, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required")

    config = Config(
        s3={"addressing_style": "path"},
        retries={"max_attempts": 3, "mode": "standard"},
    )

    _S3_CLIENT = boto3.client(
        "s3",
        endpoint_url=endpoint,
        region_name=region,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        config=config,
    )
    return _S3_CLIENT


def upload_output(
    file_obj: BinaryIO,
    file_name: str,
    mime_type: str,
    tenant_prefix: str,
    file_id: str,
) -> dict:
    """Upload a rendered file to object storage or a local directory."""
    local_dir = os.environ.get("PLUGIN_LOCAL_OUTPUT_DIR", "")
    if local_dir:
        return _upload_local(file_obj, file_name, mime_type, tenant_prefix, file_id, local_dir)

    bucket = os.environ.get("S3_BUCKET", "")
    if not bucket:
        raise RuntimeError("S3_BUCKET is not configured")

    key = f"tenants/{tenant_prefix}/{file_id}/{file_name}"
    client = get_s3_client()

    logger.info("Uploading %s to s3://%s/%s", file_name, bucket, key)
    file_obj.seek(0)
    client.put_object(
        Bucket=bucket,
        Key=key,
        Body=file_obj,
        ContentType=mime_type,
        ACL="private",
    )

    endpoint = os.environ.get("S3_ENDPOINT", "").rstrip("/")
    download_url = f"{endpoint}/{bucket}/{key}"

    file_obj.seek(0, os.SEEK_END)
    size_bytes = file_obj.tell()

    return {
        "file_id": file_id,
        "file_name": file_name,
        "mime_type": mime_type,
        "size_bytes": size_bytes,
        "storage_key": key,
        "download_url": download_url,
    }


def _upload_local(
    file_obj: BinaryIO,
    file_name: str,
    mime_type: str,
    tenant_prefix: str,
    file_id: str,
    local_dir: str,
) -> dict:
    import pathlib

    out_dir = pathlib.Path(local_dir) / "tenants" / tenant_prefix / file_id
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / file_name

    file_obj.seek(0)
    out_path.write_bytes(file_obj.read())

    file_obj.seek(0, os.SEEK_END)
    size_bytes = file_obj.tell()

    url_prefix = os.environ.get("PLUGIN_LOCAL_URL_PREFIX", "")
    if url_prefix:
        download_url = f"{url_prefix.rstrip('/')}/tenants/{tenant_prefix}/{file_id}/{file_name}"
    else:
        download_url = out_path.resolve().as_uri()

    logger.info("Saved local plugin output %s (%d bytes)", out_path, size_bytes)
    return {
        "file_id": file_id,
        "file_name": file_name,
        "mime_type": mime_type,
        "size_bytes": size_bytes,
        "storage_key": str(out_path.resolve()),
        "download_url": download_url,
    }


def get_download_url(storage_key: str, expires_in: int = 300) -> str:
    """Generate a time-limited presigned URL for an object in object storage."""
    bucket = os.environ.get("S3_BUCKET", "")
    if not bucket:
        raise RuntimeError("S3_BUCKET is not configured")

    client = get_s3_client()
    return client.generate_presigned_url(
        "get_object",
        Params={"Bucket": bucket, "Key": storage_key},
        ExpiresIn=expires_in,
    )
