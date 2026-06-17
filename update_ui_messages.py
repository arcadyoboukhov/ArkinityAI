#!/usr/bin/env python3
"""Update renderer.js with better UX messages"""

content = open('electron/renderer.js', 'r', encoding='utf-8').read()

# Update install messages - try multiple quote types
replacements = [
    # Try smart quotes
    ('Installation complete. Click "Check Dependencies" to verify.', 
     '✅ ML packages installed! Click "Check Dependencies" to verify and see your system specs.'),
    ('Installation complete. Click "Check Dependencies" to verify.', 
     '✅ ML packages installed! Click "Check Dependencies" to verify and see your system specs.'),
    # Try straight quotes  
    ('Installation complete. Click "Check Dependencies" to verify.', 
     '✅ ML packages installed! Click "Check Dependencies" to verify and see your system specs.'),
    # Missing packages  
    ('Some ML packages missing. Click "Install ML Packages" to auto-download (~2-5 min with GPU, ~10-15 min on CPU).',
     '⚙️  Some ML packages missing. Click "Install ML Packages" to auto-download (~2-5 min with GPU, ~10-15 min on CPU).'),
    # GPU detection messages
    ('GPU detected',
     '🚀 GPU detected'),
    ('No GPU detected',
     '💡 No GPU detected'),
]

for old, new in replacements:
    if old in content:
        content = content.replace(old, new)
        print(f'✅ Replaced: {old[:40]}...')
    else:
        print(f'⚠️  Not found: {old[:40]}...')

open('electron/renderer.js', 'w', encoding='utf-8').write(content)
print('\n✅ Updated renderer.js with UX improvements')

