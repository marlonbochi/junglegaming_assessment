#!/bin/bash
set -euo pipefail

awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false

DLQ_ARN=$(awslocal sqs get-queue-attributes \
  --queue-url "$(awslocal sqs get-queue-url --queue-name wager-transactions-dlq.fifo --query QueueUrl --output text)" \
  --attribute-names QueueArn --query Attributes.QueueArn --output text)

cat > /tmp/wager-attrs.json <<JSON
{
  "FifoQueue": "true",
  "ContentBasedDeduplication": "false",
  "VisibilityTimeout": "30",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"${DLQ_ARN}\",\"maxReceiveCount\":\"5\"}"
}
JSON
awslocal sqs create-queue --queue-name wager-transactions.fifo --attributes file:///tmp/wager-attrs.json

awslocal sqs create-queue --queue-name wallet-events.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=false
