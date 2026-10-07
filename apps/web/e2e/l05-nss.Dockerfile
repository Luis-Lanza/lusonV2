# Test-only NSS tool. No application sources or private build context.
FROM node:26.8.1-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends libnss3-tools \
 && apt-get clean
USER 1000:1000
