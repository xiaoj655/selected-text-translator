const { build } = require('../package.json')

module.exports = {
  ...build,
  appId: 'io.github.xiaoj655.selected-text-translator.preview',
  productName: 'Selected Text Translator Preview',
  extraMetadata: { main: 'prototype/main.js' },
  files: [
    'package.json',
    'prototype/**/*',
    '!prototype/builder.cjs',
    'src/chrome-shim-main.js',
    'src/storage.js',
    'vendor/**/*',
  ],
}
