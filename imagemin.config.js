const imagemin = require('imagemin');
const imageminPngquant = require('imagemin-pngquant');
const imageminMozjpeg = require('imagemin-mozjpeg');

(async () => {
  const files = await imagemin(['assets/images/*.{jpg,jpeg,png}'], {
    destination: 'assets/images/optimized',
    plugins: [
      imageminMozjpeg({
        quality: 85,
        progressive: true
      }),
      imageminPngquant({
        quality: [0.8, 0.9],
        speed: 1
      })
    ]
  });

  console.log('Images optimized:');
  files.forEach(file => {
    console.log(`✓ ${file.sourcePath} → ${file.destinationPath}`);
  });
})();