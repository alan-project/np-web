#!/bin/bash

# News Platter Web Development Setup Script
# This script sets up the development environment for the News Platter website

echo "🚀 Setting up News Platter Web Development Environment..."

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js first:"
    echo "   Visit: https://nodejs.org/"
    exit 1
fi

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "❌ npm is not installed. Please install npm first."
    exit 1
fi

echo "✅ Node.js version: $(node --version)"
echo "✅ npm version: $(npm --version)"

# Install dependencies
echo "📦 Installing development dependencies..."
npm install

# Create necessary directories
echo "📁 Creating directories..."
mkdir -p assets/images/optimized
mkdir -p temp
mkdir -p logs

# Make scripts executable
chmod +x scripts/*.sh

# Create local development aliases
echo "📝 Creating development aliases..."
cat > ~/.news-platter-aliases << 'EOF'
# News Platter Development Aliases
alias np-dev='cd /Users/alankim/Desktop/dev/personal/repo/news_platter/web && npm run dev'
alias np-build='cd /Users/alankim/Desktop/dev/personal/repo/news_platter/web && npm run build'
alias np-serve='cd /Users/alankim/Desktop/dev/personal/repo/news_platter/web && npm run serve'
alias np-validate='cd /Users/alankim/Desktop/dev/personal/repo/news_platter/web && npm run validate'
alias np-clean='cd /Users/alankim/Desktop/dev/personal/repo/news_platter/web && npm run clean'
alias np-optimize='cd /Users/alankim/Desktop/dev/personal/repo/news_platter/web && npm run optimize-images'
alias np-cd='cd /Users/alankim/Desktop/dev/personal/repo/news_platter/web'
EOF

echo "✅ Development environment setup complete!"
echo ""
echo "📋 Available Commands:"
echo "  npm run dev      - Start development server with live reload"
echo "  npm run build    - Build and validate the project"
echo "  npm run validate - Validate HTML files"
echo "  npm run serve    - Serve files with http-server"
echo "  npm run clean    - Clean generated files"
echo ""
echo "🔧 Useful Aliases (add to your ~/.bashrc or ~/.zshrc):"
echo "  source ~/.news-platter-aliases"
echo ""
echo "🌐 To start development:"
echo "  npm run dev"
echo "  Then visit: http://localhost:3000"