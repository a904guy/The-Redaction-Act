#!/bin/bash
mkdir -p dist
find . -maxdepth 1 -type f -print0 | xargs -0 zip -j dist/TheRedactionAct.zip