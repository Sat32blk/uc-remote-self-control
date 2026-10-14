#!/bin/sh
# Builds the install archive for the remote: dist/uc-intg-self-control-<version>.tar.gz
set -e
cd "$(dirname "$0")"
VERSION=$(node -p "require('./src/driver.json').version")
rm -rf build && mkdir -p build/bin dist
cp src/driver.json build/
cp src/bin/*.js src/bin/*.json build/bin/
cp -r src/bin/web build/bin/
(cd build/bin && npm install --omit=dev --no-package-lock && rm -rf node_modules/.bin)
(cd build && tar --owner=0 --group=0 -czf "../dist/uc-intg-self-control-$VERSION.tar.gz" driver.json bin)
echo "dist/uc-intg-self-control-$VERSION.tar.gz"
