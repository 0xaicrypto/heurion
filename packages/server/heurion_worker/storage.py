"""Object storage upload helpers for the Execution Plane."""

import os
import logging
from typing import BinaryIO

logger = logging.getLogger("heurion-worker.storage")

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
        # Some S3-compatible providers (e.g. DigitalOcean Spaces) use virtual-
        # hosted style by default; path-style is simpler for bucket names that
        # contain dots.
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
    """Upload a rendered file to object storage.

    The object key is structured as ``tenants/{tenant_prefix}/{file_id}/{file_name}``
    so that outputs are isolated by workspace/tenant.
    """
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

    # Construct a download URL. For S3-compatible providers the bucket is part
    # of the path because we use path-style addressing.
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
