#!/bin/bash

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )

if $(false)
then

# Check if OpenCV is already built and up-to-date
if [[ -f ${SCRIPT_DIR}/vendor/opencv.js ]] && [[ -f ${SCRIPT_DIR}/public/opencv-inventory.json ]]; then
  INVENTORY_SHA=$(grep -o '"buildFingerprint"[ :]*"[^"]*' ${SCRIPT_DIR}/public/opencv-inventory.json | cut -d'"' -f4)
  BINARY_SIZE=$(stat -f%z ${SCRIPT_DIR}/vendor/opencv.js 2>/dev/null || stat -c%s ${SCRIPT_DIR}/vendor/opencv.js 2>/dev/null)
  
  if [[ -n "$INVENTORY_SHA" ]] && [[ $BINARY_SIZE -gt 3000000 ]]; then
    echo "✓ OpenCV.js is already built and up-to-date ($(numfmt --to=iec-i --suffix=B $BINARY_SIZE 2>/dev/null || echo $BINARY_SIZE bytes))"
    exit 0
  fi
fi

# the assumption is that 'python3, cmake and git' are available

### Install Emscripten 4.0.17
EMSCRIPTEN_REV=4.0.17
[[ -d ${SCRIPT_DIR}/extern/emsdk ]] || git clone https://github.com/emscripten-core/emsdk.git ${SCRIPT_DIR}/extern/emsdk
cd ${SCRIPT_DIR}/extern/emsdk
./emsdk install ${EMSCRIPTEN_REV}
./emsdk activate ${EMSCRIPTEN_REV}

source ${SCRIPT_DIR}/extern/emsdk/emsdk_env.sh
emcc --version  # Should show 4.0.17

### Checkout OpenCV source branch 5.0.0
OPENCV_REV=5.0.0
[[ -d ${SCRIPT_DIR}/extern/opencv ]] || git clone --branch ${OPENCV_REV} --depth 1 https://github.com/opencv/opencv.git ${SCRIPT_DIR}/extern/opencv
cd ${SCRIPT_DIR}/extern/opencv
git checkout tags/${OPENCV_REV} -B ${OPENCV_REV}

## Isolated Build Environment
export OPENCV_SOURCE=${SCRIPT_DIR}/extern/opencv
export OPENCV_BUILD_DIR=${SCRIPT_DIR}/extern/opencv-build-$(date +%s)
mkdir -p $OPENCV_BUILD_DIR

cd ${SCRIPT_DIR}
npm run build:opencv

exit 0
fi

# Validation: Check that newly built opencv.js is complete
node ${SCRIPT_DIR}/scripts/validate-opencv.mjs

## Leave the cloned source archives intact, but clean up the build environment
rm -rf $OPENCV_BUILD_DIR
