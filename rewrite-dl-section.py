#!/usr/bin/env python3
"""Rewrite deep learning section with full UX improvements"""

with open('electron/renderer.js', 'r', encoding='utf-8') as f:
    lines = f.readlines()

# Find where dlCheckDepsBtn event listener starts
start_idx = None
for i, line in enumerate(lines):
    if 'if (dlCheckDepsBtn)' in line and 'addEventListener' in lines[i+1]:
        start_idx = i
        break

if start_idx is None:
    print("Could not find dlCheckDepsBtn section")
    exit(1)

# Find where the Install button section ends (look for next major section)
end_idx = None
for i in range(start_idx + 1, len(lines)):
    if 'window.arcinityAPI.onDeepLearnProgress' in lines[i]:
        end_idx = i
        break

if end_idx is None:
    end_idx = len(lines)

print(f"Found deep learning event listeners section: lines {start_idx} to {end_idx}")

# New improved section
new_section = '''if (dlCheckDepsBtn) {
  dlCheckDepsBtn.addEventListener('click', async () => {
    dlCheckDepsBtn.disabled = true;
    dlCheckDepsBtn.textContent = '⏳ Checking…';
    setDlMessage('');
    if (dlDepPanel) dlDepPanel.style.display = '';
    // Reset icons to spinning state
    for (const el of [dlDepPythonIcon, dlDepWhisperIcon, dlDepVisualIcon, dlDepAudioIcon]) {
      if (el) { el.textContent = '⋯'; el.className = 'dl-dep-icon dl-dep-unknown'; }
    }
    try {
      const result = await window.arcinityAPI.deepLearnCheckDeps();
      if (!result.ok && !result.deps) {
        setDlMessage('❌ ' + (result.error || 'Could not check dependencies. Make sure Python 3.8+ is installed.'), 'error');
        if (dlDepPythonIcon) { dlDepPythonIcon.textContent = '✗'; dlDepPythonIcon.className = 'dl-dep-icon dl-dep-missing'; }
        if (dlDepPythonLabel) dlDepPythonLabel.textContent = result.error || 'Python 3.8+ not found';
      } else {
        applyDepStatus(result.deps || {}, result.python || null);
        if (dlState.hasMissingDeps) {
          setDlMessage('⚙️  Some ML packages missing. Click "Install ML Packages" to auto-download (~2-5 min with GPU, ~10-15 min on CPU).');
        } else {
          let msg = '✅ Ready to index! All dependencies installed.';
          if (result.deps && result.deps.gpu_available && result.deps.gpu_device) {
            msg += ` 🚀 GPU detected (${result.deps.gpu_device}) — processing will be ~5-10× faster!`;
          } else if (result.deps && !result.deps.gpu_available) {
            msg += ' 💡 No GPU detected, using CPU mode (works fine, just slower).';
          }
          setDlMessage(msg, 'success');
        }
      }
    } catch (e) {
      setDlMessage('⚠️  Dependency check failed: ' + e.message, 'error');
    } finally {
      dlCheckDepsBtn.disabled = false;
      dlCheckDepsBtn.textContent = 'Check Dependencies';
    }
  });
}

if (dlInstallBtn) {
  dlInstallBtn.addEventListener('click', async () => {
    dlInstallBtn.disabled = true;
    dlInstallBtn.textContent = '⏳ Installing…';
    if (dlInstallLog) dlInstallLog.style.display = 'none';
    setDlMessage('📦 Downloading ML packages (faster-whisper, torch, transformers, librosa)…\\nThis takes 2-5 min with GPU access, ~10-15 min on slower connections. Please wait…');
    try {
      const result = await window.arcinityAPI.deepLearnInstallDeps();
      if (dlInstallLog) {
        dlInstallLog.style.display = '';
        dlInstallLog.textContent = result.log || result.message || 'Installation output not available';
      }
      if (result.ok) {
        setDlMessage('✅ ML packages installed! Click "Check Dependencies" to verify and see your system specs.', 'success');
      } else {
        setDlMessage('⚠️  Installation finished with some errors. Check the log above. You may still be able to index videos.', 'error');
      }
    } catch (e) {
      setDlMessage('❌ Install error: ' + e.message, 'error');
    } finally {
      dlInstallBtn.disabled = false;
      dlInstallBtn.textContent = 'Install ML Packages';
    }
  });
}

async function runDeepLearning(reindex = false) {
  const folder = videoFolderInput.value.trim();
  if (!folder) { setDlMessage('📁 Select a video folder first in the Home tab.', 'error'); return; }
  if (!dlState.outputPath) { setDlMessage('Output path not resolved.', 'error'); return; }

  dlState.running = true;
  if (dlProgressBar)  dlProgressBar.style.width  = '0%';
  if (dlProgressText) dlProgressText.textContent  = '⏳ Initializing AI models…';
  const qualityText = {'fast': 'Fast (5-10s/video)', 'balanced': 'Balanced (30-50s/video)', 'quality': 'Highest Quality (50+s/video)'}[dlState.selectedQuality] || dlState.selectedQuality;
  if (dlStageText)    dlStageText.textContent      = `Quality: ${qualityText} — First run loads ML models (~30-60s), then processes videos. You can cancel anytime.`;
  setDlMessage('');
  updateDlUI();

  let result;
  try {
    result = await window.arcinityAPI.deepLearnRun({
      videoSourceDir: folder,
      outputPath: dlState.outputPath,
      reindex,
      quality: dlState.selectedQuality,
      skipSpeech: false,
      visualMode: null,
    });
  } catch (e) {
    result = { ok: false, error: e.message };
  }

  dlState.running = false;
  if (dlProgressWrap) dlProgressWrap.style.display = 'none';

  if (result && result.cancelled) {
    setDlMessage('⏹️  Indexing cancelled. Your progress was saved — you can resume later.');
  } else if (!result || !result.ok) {
    const errMsg = (result && result.error) || 'Indexing failed.';
    if (errMsg.toLowerCase().includes('python')) {
      setDlMessage('❌ ' + errMsg + ' — Please install Python 3.8+ from python.org and restart the launcher.', 'error');
    } else if (errMsg.toLowerCase().includes('out of memory') || errMsg.toLowerCase().includes('cuda')) {
      setDlMessage('⚠️  GPU memory issue. Try the "Fast" preset or run on a computer with more VRAM. Details: ' + errMsg, 'error');
    } else {
      setDlMessage('❌ ' + errMsg, 'error');
    }
  } else {
    const d = result.data || {};
    const errNote = d.errors > 0 ? ` (⚠️  ${d.errors} skipped)` : '';
    setDlMessage(`✅ Indexed ${d.done} video${d.done !== 1 ? 's' : ''}${errNote}. Smart recommendations now enabled!`, 'success');
  }

  await deeplearnScan();
}

if (dlRunBtn) {
  dlRunBtn.addEventListener('click', () => runDeepLearning(false));
}

if (dlReindexBtn) {
  dlReindexBtn.addEventListener('click', () => runDeepLearning(true));
}

if (dlCancelBtn) {
  dlCancelBtn.addEventListener('click', async () => {
    dlCancelBtn.disabled = true;
    try { await window.arcinityAPI.deepLearnCancel(); } catch {}
    dlCancelBtn.disabled = false;
  });
}

// Quality selector buttons
if (dlQualityFastBtn) {
  dlQualityFastBtn.addEventListener('click', () => {
    dlState.selectedQuality = 'fast';
    updateQualityButtons();
  });
}

if (dlQualityBalancedBtn) {
  dlQualityBalancedBtn.addEventListener('click', () => {
    dlState.selectedQuality = 'balanced';
    updateQualityButtons();
  });
}

if (dlQualityQualityBtn) {
  dlQualityQualityBtn.addEventListener('click', () => {
    dlState.selectedQuality = 'quality';
    updateQualityButtons();
  });
}

function updateQualityButtons() {
  const buttons = [dlQualityFastBtn, dlQualityBalancedBtn, dlQualityQualityBtn];
  buttons.forEach(btn => {
    if (btn) {
      const isActive = btn.dataset.quality === dlState.selectedQuality;
      btn.classList.toggle('btn-quality-active', isActive);
    }
  });
}

'''

# Replace the section
new_lines = lines[:start_idx] + [new_section] + lines[end_idx:]

with open('electron/renderer.js', 'w', encoding='utf-8') as f:
    f.writelines(new_lines)

print('✅ Replaced deep learning event listeners section with improved UX')
