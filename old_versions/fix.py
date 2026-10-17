import sys

with open('src/control.html', 'r', encoding='utf-8') as f:
    content = f.read()

target = """      } else {
        // DUAL MODE: Mic only logs Candidate speech
        if (data.type === 'UtteranceEnd') {
          if (candidateTranscript.length > 5) {
            currentSessionQA.push({ role: 'candidate', text: candidateTranscript });
            ipcRenderer.send('candidate-spoke', candidateTranscript);
            candidateTranscript = '';
          }
          return;
          candidateTranscript += (candidateTranscript ? ' ' : '') + transcript;
          candidateTranscript = candidateTranscript.trim();
          // Update transcript display in UI (optional, can append to interviewer context)
          $('transcript').innerHTML = `<span class="t-final" style="color:var(--accent);">You: ${esc(candidateTranscript)}</span>`;
          if (data.speech_final && candidateTranscript.length > 5) {
            currentSessionQA.push({ role: 'candidate', text: candidateTranscript });
            ipcRenderer.send('candidate-spoke', candidateTranscript);
            candidateTranscript = '';
          }
        }
      }
    } catch(e) { console.warn('Deepgram parse error:', e); }"""

replace = """      } else {
        // DUAL MODE: Mic only logs Candidate speech
        if (data.type === 'UtteranceEnd') {
          if (candidateTranscript.length > 5) {
            currentSessionQA.push({ role: 'candidate', text: candidateTranscript });
            ipcRenderer.send('candidate-spoke', candidateTranscript);
            candidateTranscript = '';
          }
          return;
        }
        const alt = data?.channel?.alternatives?.[0];
        if (!alt) return;
        const transcript = alt.transcript?.trim();
        
        let displayString = candidateTranscript;
        if (!data.is_final && transcript) {
           displayString = candidateTranscript + (candidateTranscript ? ' ' : '') + transcript;
           ipcRenderer.send('candidate-interim', displayString.trim());
        }

        if (data.is_final && transcript) {
          candidateTranscript += (candidateTranscript ? ' ' : '') + transcript;
          candidateTranscript = candidateTranscript.trim();
          ipcRenderer.send('candidate-interim', candidateTranscript);
          
          $('transcript').innerHTML = `<span class="t-final" style="color:var(--accent);">You: ${esc(candidateTranscript)}</span>`;
          if (data.speech_final && candidateTranscript.length > 5) {
            currentSessionQA.push({ role: 'candidate', text: candidateTranscript });
            ipcRenderer.send('candidate-spoke', candidateTranscript);
            candidateTranscript = '';
          }
        }
      }
    } catch(e) { console.warn('Deepgram parse error:', e); }"""

# Try direct replace
if target in content:
    content = content.replace(target, replace)
    print("Fixed with LF!")
elif target.replace('\\n', '\\r\\n') in content:
    content = content.replace(target.replace('\\n', '\\r\\n'), replace.replace('\\n', '\\r\\n'))
    print("Fixed with CRLF!")
else:
    print("Target not found.")

with open('src/control.html', 'w', encoding='utf-8') as f:
    f.write(content)
