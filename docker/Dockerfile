# DedrisGenAI — containerized full app: Python engine (FastAPI) + PHP web UI.
# Build context is the REPO ROOT so both engine/ and webui/ are available:
#   docker build -f docker/Dockerfile -t dedrisgenai .
# The container runs the engine on 127.0.0.1:7866 (internal) and serves the PHP
# UI on 0.0.0.0:8888 (exposed) — NOT the legacy Gradio UI.
FROM nvidia/cuda:12.4.1-base-ubuntu22.04
ENV DEBIAN_FRONTEND=noninteractive
ENV DEDRIS_ENGINE_PORT=7866
ENV DEDRIS_UI_PORT=8888
ENV DEDRIS_HOST=0.0.0.0

RUN apt-get update -y && \
	apt-get install -y curl libgl1 libglib2.0-0 python3-pip python-is-python3 git php-cli && \
	apt-get clean && \
	rm -rf /var/lib/apt/lists/*

# Python deps for the engine (paths are relative to the repo-root build context).
COPY engine/requirements_docker.txt engine/requirements_versions.txt /tmp/
RUN pip install --no-cache-dir -r /tmp/requirements_docker.txt -r /tmp/requirements_versions.txt && \
	rm -f /tmp/requirements_docker.txt /tmp/requirements_versions.txt
RUN pip install --no-cache-dir xformers==0.0.23 --no-dependencies

RUN adduser --disabled-password --gecos '' user && \
	mkdir -p /content/app /content/data

COPY docker/entrypoint.sh /content/entrypoint.sh
RUN chmod +x /content/entrypoint.sh && chown -R user:user /content

WORKDIR /content/app
USER user

# Copy the app. Model weights (*.safetensors/*.bin/...) and runtimes/ are excluded
# via .dockerignore, so the image stays lean; weights are downloaded at runtime into
# the persistent data volume. The small expansion support files (config/tokenizer)
# ARE copied and seeded into the volume by entrypoint.sh.
COPY --chown=user:user engine /content/app/engine
COPY --chown=user:user webui  /content/app/webui
RUN mv /content/app/engine/models /content/app/engine/models.org

EXPOSE 8888
CMD [ "/content/entrypoint.sh" ]
