const fs = require('fs');
let c = fs.readFileSync('src/control.html', 'utf8');

const replacement = `        // DUAL MODE: Mic only logs Candidate speech
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
        }`;

// Replace everything between DUAL MODE comment and '      } catch(e) { console.warn'
const startIdx = c.indexOf('// DUAL MODE: Mic only logs Candidate speech');
const endIdx = c.indexOf('} catch(e) { console.warn(\\'Deepgram parse error:\\', e); }');

if (startIdx > -1 && endIdx > -1) {
  const exactEndIdx = c.indexOf('      }\\n    } catch(e) { console.warn(\\'Deepgram parse error:\\', e); }', startIdx);
  if (exactEndIdx > -1) {
    const freshString = c.substring(0, startIdx) + replacement + '\\n' + c.substring(exactEndIdx);
    fs.writeFileSync('src/control.html', freshString);
    console.log('Fixed completely!');
  } else {
    // try with \\r\\n
    const exactEndIdx2 = c.indexOf('      }\\r\\n    } catch(e) { console.warn(\\'Deepgram parse error:\\', e); }', startIdx);
    if (exactEndIdx2 > -1) {
       const freshString = c.substring(0, startIdx) + replacement + '\\r\\n' + c.substring(exactEndIdx2);
       fs.writeFileSync('src/control.html', freshString);
       console.log('Fixed completely with CRLF!');
    } else {
       console.log('Could not find the exact end index');
    }
  }
} else {
  console.log('Could not find boundaries');
}
