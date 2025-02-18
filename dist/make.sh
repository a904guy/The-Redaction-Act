#!/bin/bash
mkdir -p dist
zip -FS -j dist/TheRedactionAct.zip $(find . -maxdepth 1 -type f)