const { app, BrowserWindow } = require('electron');

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 800, height: 600 });
  
  const html = `
    <html><body>
      <div id="log"></div>
      <script>
        function log(msg) { document.getElementById('log').innerHTML += msg + '<br>'; console.log(msg); }
        
        try {
          const ws = new WebSocket('wss://api.deepgram.com/v1/listen', ['token', '2434fd4b4d2d2960cc386b154687fccf5178a6e7']);
          ws.onopen = () => { log('✅ CONNECTED TO DEEPGRAM!'); ws.close(); };
          ws.onerror = (e) => { log('❌ ERROR!'); };
          ws.onclose = (e) => { log('❌ CLOSED: ' + e.code + ' ' + e.reason); };
        } catch(e) { log('Exception: ' + e.message); }
      </script>
    </body></html>
  `;
  
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  
  setTimeout(() => app.quit(), 5000);
});
