const fs = require('fs');
let content = fs.readFileSync('src/control.html', 'utf8');

const targetStr = `      } else {
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
          $('transcript').innerHTML = \`<span class="t-final" style="color:var(--accent);">You: \${esc(candidateTranscript)}</span>\`;
          if (data.speech_final && candidateTranscript.length > 5) {
            currentSessionQA.push({ role: 'candidate', text: candidateTranscript });
            ipcRenderer.send('candidate-spoke', candidateTranscript);
            candidateTranscript = '';
          }
        }
      }`;

const replaceStr = `      } else {
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
          
          $('transcript').innerHTML = \`<span class="t-final" style="color:var(--accent);">You: \${esc(candidateTranscript)}</span>\`;
          if (data.speech_final && candidateTranscript.length > 5) {
            currentSessionQA.push({ role: 'candidate', text: candidateTranscript });
            ipcRenderer.send('candidate-spoke', candidateTranscript);
            candidateTranscript = '';
          }
        }
      }`;

if (content.includes(targetStr)) {
  content = content.replace(targetStr, replaceStr);
  fs.writeFileSync('src/control.html', content);
  console.log('Fixed exactly!');
} else {
  console.log('Target string not found');
}
