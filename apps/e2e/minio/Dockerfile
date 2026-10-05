# syntax=docker/dockerfile:1
# The public MinIO registries no longer serve the release used by this suite.
# Build the same official source commit, with a checked archive, instead.
FROM golang:1.24.6-alpine@sha256:c8c5f95d64aa79b6547f3b626eb84b16a7ce18a139e3e9ca19a8c078b85ba80d AS build
WORKDIR /src
ADD --checksum=sha256:8819e3e7817e46b7b3798f8f200ead208562e571563c2e040352378031abe9f2 https://codeload.github.com/minio/minio/tar.gz/07c3a429bfed433e49018cb0f78a52145d4bedeb /tmp/minio.tar.gz
RUN tar -xzf /tmp/minio.tar.gz --strip-components=1
ENV CGO_ENABLED=0
RUN go build -trimpath -ldflags="-s -w -X github.com/minio/minio/cmd.Version=2025-09-07T16:13:09Z -X github.com/minio/minio/cmd.ReleaseTag=RELEASE.2025-09-07T16-13-09Z -X github.com/minio/minio/cmd.CommitID=07c3a429bfed433e49018cb0f78a52145d4bedeb -X github.com/minio/minio/cmd.CopyrightYear=2025" -o /minio .

FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8
RUN apk add --no-cache ca-certificates
COPY --from=build /minio /usr/local/bin/minio
COPY --from=build /src/LICENSE /licenses/MinIO-LICENSE
ENTRYPOINT ["minio"]
CMD ["server", "/data"]
