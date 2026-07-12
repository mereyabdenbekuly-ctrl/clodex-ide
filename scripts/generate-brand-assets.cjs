#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
const markPath = path.join(root, 'apps/website/public/clodex-mark.png');
const lightComboPath = path.join(
  root,
  'apps/website/public/clodex-logo-on-light.png',
);
const darkComboPath = path.join(
  root,
  'apps/website/public/clodex-logo-on-dark.png',
);
const iconChannels = ['dev', 'nightly', 'release'];
const iconSizes = [16, 32, 48, 64, 96, 128, 256, 512, 1024];

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function embeddedPngSvg(pngBuffer, width, height) {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg"',
    ` width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<image width="${width}" height="${height}" href="data:image/png;base64,${pngBuffer.toString('base64')}"/>`,
    '</svg>',
    '',
  ].join('');
}

function writePngIco(entries, destination) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  let offset = 6 + count * 16;
  const directory = Buffer.alloc(count * 16);
  for (const [index, entry] of entries.entries()) {
    const entryOffset = index * 16;
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, entryOffset);
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, entryOffset + 1);
    directory.writeUInt8(0, entryOffset + 2);
    directory.writeUInt8(0, entryOffset + 3);
    directory.writeUInt16LE(1, entryOffset + 4);
    directory.writeUInt16LE(32, entryOffset + 6);
    directory.writeUInt32LE(entry.buffer.length, entryOffset + 8);
    directory.writeUInt32LE(offset, entryOffset + 12);
    offset += entry.buffer.length;
  }

  fs.writeFileSync(
    destination,
    Buffer.concat([header, directory, ...entries.map((entry) => entry.buffer)]),
  );
}

async function generateIcns(master, destination) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clodex-icon-'));
  const iconset = path.join(tempRoot, 'Clodex.iconset');
  ensureDirectory(iconset);

  const specifications = [
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024],
  ];

  try {
    for (const [name, size] of specifications) {
      await sharp(master)
        .resize(size, size, { fit: 'fill' })
        .png()
        .toFile(path.join(iconset, name));
    }
    execFileSync('/usr/bin/iconutil', [
      '--convert',
      'icns',
      '--output',
      destination,
      iconset,
    ]);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function main() {
  const sourceMark = await sharp(markPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let offset = 0; offset < sourceMark.data.length; offset += 4) {
    const red = sourceMark.data[offset];
    const green = sourceMark.data[offset + 1];
    const blue = sourceMark.data[offset + 2];
    const isBrandGreen = green > 72 && green > red * 1.25 && green > blue;
    if (!isBrandGreen) sourceMark.data[offset + 3] = 0;
  }
  const cleanMark = await sharp(sourceMark.data, {
    raw: sourceMark.info,
  })
    .png()
    .toBuffer();
  const trimmedMark = await sharp(cleanMark)
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .resize(650, 650, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  const background = Buffer.from(`
    <svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="glow" cx="50%" cy="43%" r="72%">
          <stop offset="0" stop-color="#123e2d"/>
          <stop offset="0.55" stop-color="#07130f"/>
          <stop offset="1" stop-color="#030806"/>
        </radialGradient>
      </defs>
      <rect x="20" y="20" width="984" height="984" rx="220" fill="url(#glow)"/>
      <rect x="22" y="22" width="980" height="980" rx="218" fill="none" stroke="#32ff9a" stroke-opacity="0.22" stroke-width="4"/>
    </svg>
  `);

  const master = await sharp(background)
    .composite([{ input: trimmedMark, left: 187, top: 187 }])
    .png()
    .toBuffer();

  for (const channel of iconChannels) {
    const directory = path.join(root, 'apps/browser/assets/icons', channel);
    ensureDirectory(directory);
    const icoEntries = [];

    for (const size of iconSizes) {
      const buffer = await sharp(master)
        .resize(size, size, { fit: 'fill' })
        .png()
        .toBuffer();
      fs.writeFileSync(path.join(directory, `icon-${size}.png`), buffer);
      if ([16, 32, 48, 64, 128, 256].includes(size)) {
        icoEntries.push({ size, buffer });
      }
    }

    fs.copyFileSync(
      path.join(directory, 'icon-512.png'),
      path.join(directory, 'icon.png'),
    );
    writePngIco(icoEntries, path.join(directory, 'icon.ico'));
    await generateIcns(master, path.join(directory, 'icon.icns'));
  }

  const pageIconDirectory = path.join(root, 'apps/browser/assets/pages/icons');
  ensureDirectory(pageIconDirectory);
  for (const size of [64, 256]) {
    await sharp(master)
      .resize(size, size, { fit: 'fill' })
      .png()
      .toFile(path.join(pageIconDirectory, `icon-${size}.png`));
  }

  const mark = cleanMark;
  const mark512 = await sharp(mark).resize(512, 512).png().toBuffer();
  const mark1024 = await sharp(mark).resize(1024, 1024).png().toBuffer();
  fs.writeFileSync(path.join(root, 'logo.png'), mark512);
  fs.writeFileSync(path.join(root, 'logo@2x.png'), mark1024);
  fs.writeFileSync(path.join(root, 'logo.svg'), embeddedPngSvg(mark, 512, 512));

  const lightCombo = fs.readFileSync(lightComboPath);
  const darkCombo = fs.readFileSync(darkComboPath);
  fs.writeFileSync(
    path.join(root, 'logo-combo.svg'),
    embeddedPngSvg(lightCombo, 615, 111),
  );
  fs.writeFileSync(
    path.join(root, 'logo-combo-dark.svg'),
    embeddedPngSvg(darkCombo, 615, 111),
  );
  fs.writeFileSync(
    path.join(root, 'logo-text.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="520" height="96" viewBox="0 0 520 96"><text x="0" y="74" fill="#111827" font-family="Arial Black, Arial, sans-serif" font-size="72" font-weight="900" letter-spacing="8">CLODEX</text></svg>\n',
  );

  fs.writeFileSync(
    path.join(root, 'apps/website/public/logo-with-text.svg'),
    embeddedPngSvg(lightCombo, 615, 111),
  );
  fs.writeFileSync(
    path.join(root, 'apps/website/public/logo-with-text-white.svg'),
    embeddedPngSvg(darkCombo, 615, 111),
  );

  for (const destination of [
    'apps/website/public/clodex-mark.png',
    'apps/website/public/icon.png',
    'apps/website/src/app/icon.png',
    'apps/browser/assets/pages/clodex-mark.png',
    'packages/stage-ui/src/components/clodex-mark.png',
  ]) {
    const absolutePath = path.join(root, destination);
    ensureDirectory(path.dirname(absolutePath));
    fs.writeFileSync(absolutePath, mark);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
