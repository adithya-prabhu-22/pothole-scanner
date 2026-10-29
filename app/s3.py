import boto3, json, os

_s3 = boto3.client("s3")
BUCKET = os.environ["BUCKET_NAME"]


def put_bytes(key, body, content_type):
    _s3.put_object(Bucket=BUCKET, Key=key, Body=body, ContentType=content_type)


def put_json(key, obj):
    put_bytes(key, json.dumps(obj).encode(), "application/json")


def get_json(key):
    return json.loads(_s3.get_object(Bucket=BUCKET, Key=key)["Body"].read())


def list_keys(prefix):
    paginator = _s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=BUCKET, Prefix=prefix):
        for obj in page.get("Contents", []):
            yield obj["Key"]


def object_exists(key):
    try:
        _s3.head_object(Bucket=BUCKET, Key=key)
        return True
    except _s3.exceptions.ClientError:
        return False