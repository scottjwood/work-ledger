#!/bin/bash
# Cloudflare Pages build script
# Replaces %%PLACEHOLDER%% tokens in index.html with
# environment variable values set in Cloudflare dashboard.
# Secrets never touch the git repo.

set -e

cp index.html _index_build.html

sed -i "s|%%SCRIPT_URL%%|${SCRIPT_URL}|g" _index_build.html
sed -i "s|%%API_TOKEN%%|${API_TOKEN}|g"   _index_build.html

mkdir -p dist
mv _index_build.html dist/index.html

echo "Build complete. Secrets injected."