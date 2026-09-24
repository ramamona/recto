# Recto is static files: nginx serves the repository root as-is (no build step).
FROM nginx:alpine
COPY . /usr/share/nginx/html
