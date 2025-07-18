#!/bin/bash

# News Platter Web Deployment Script
# This script prepares the site for deployment

echo "🚀 Preparing News Platter Web for deployment..."

# Validate HTML
echo "📋 Validating HTML..."
npm run validate

if [ $? -ne 0 ]; then
    echo "❌ HTML validation failed. Please fix errors before deploying."
    exit 1
fi

# Optimize images
echo "🖼️ Optimizing images..."
npm run optimize-images

# Create deployment directory
echo "📁 Creating deployment directory..."
mkdir -p dist

# Copy files to deployment directory
echo "📦 Copying files..."
cp index.html dist/
cp terms_privacy.html dist/
cp -r assets dist/
cp app-ads.txt dist/
cp LICENSE dist/
cp README.md dist/

# Compress files for better performance
echo "🗜️ Compressing files..."
cd dist
gzip -k -f *.html
gzip -k -f *.txt
cd ..

echo "✅ Deployment preparation complete!"
echo ""
echo "📁 Deployment files are in the 'dist' directory"
echo "🌐 You can now upload the contents of 'dist' to your web server"
echo ""
echo "📊 File sizes:"
ls -lh dist/