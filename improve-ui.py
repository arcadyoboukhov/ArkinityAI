#!/usr/bin/env python3
"""Comprehensive renderer.js UX improvements"""
import re

with open('electron/renderer.js', 'r', encoding='utf-8') as f:
    content = f.read()

# GPU-related improvements
content = re.sub(
    r'msg \+= ` GPU: \${result\.deps\.gpu_device\} — ~5-10× faster!`',
    r'msg += ` 🚀 GPU detected (${result.deps.gpu_device}) — processing will be ~5-10× faster!`',
    content
)

# Add GPU detection for CPU-only systems
if 'else if (result.deps && !result.deps.gpu_available)' not in content:
    # Find the GPU detection block and add CPU fallback
    pattern = r'(msg \+= ` 🚀 GPU detected \([^)]+\) — processing will be ~5-10× faster!`;[\s\n]+)(setDlMessage\(msg, \'success\'\);)'
    replacement = r'\1} else if (result.deps && !result.deps.gpu_available) {\n            msg += \' 💡 No GPU detected, using CPU mode (works fine, just slower).\';\n          }\n          \2'
    content = re.sub(pattern, replacement, content)

# Run deep learning improvements
content = content.replace(
    'Indexing cancelled. Your progress was saved — you can resume later.',
    'Indexing cancelled. Your progress was saved — you can resume later.'
)

# Better error messages for runDeepLearning
content = re.sub(
    r'setDlMessage\(errMsg \+ \' — Install Python 3\.8\+ and restart the launcher\.\', \'error\'\);',
    r'setDlMessage(\'❌ \' + errMsg + \' — Please install Python 3.8+ from python.org and restart the launcher.\', \'error\');',
    content
)

content = re.sub(
    r'(const errMsg = \(result && result\.error\) \|\| \'Indexing failed\.\';[\s\n]+if \(errMsg\.toLowerCase\(\)\.includes\(\'python\'\)\))',
    r'const errMsg = (result && result.error) || \'❌ Indexing failed.\';\n    if (errMsg.toLowerCase().includes(\'python\'))',
    content
)

# Progress messages
content = content.replace(
    'Initialising AI models…',
    '⏳ Initializing AI models…'
)

with open('electron/renderer.js', 'w', encoding='utf-8') as f:
    f.write(content)

print('✅ Comprehensive UX updates applied to renderer.js')
