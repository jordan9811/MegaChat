# VDO.Ninja Stream Platform

**Free to watch, pay to appear on camera**

Viewers pay USDC → Their webcam automatically appears on your stream in a video box (like Ninja's facecam) → Box disappears when they leave.

## How It Works

```
Viewer clicks link
    ↓
Pays 0.01 USDC (we'll add this)
    ↓
Gets VDO.Ninja camera link (auto-opens)
    ↓
Their camera goes live
    ↓
Server adds video to overlay
    ↓
OBS shows overlay → Camera box appears on stream
    ↓
User leaves → Box animates out
```

## Quick Start

### 1. Install

```bash
cd video-stream
npm install
npm start
```

### 2. Test It

**Open 3 tabs:**
- Tab 1: `http://localhost:3000` (main page)
- Tab 2: `http://localhost:3000/overlay` (OBS overlay)
- Tab 3: VDO.Ninja link (opens automatically)

**Click "JOIN STREAM"**, enter username → Camera link opens → Your video appears in overlay tab!

### 3. Add to OBS

1. Open OBS
2. Add Source → Browser
3. URL: `http://localhost:3000/overlay`
4. Width: 1920, Height: 1080
5. Check "Shutdown source when not visible"
6. Done!

Now when people join, video boxes appear automatically on your stream.

## Files

- `server.js` - Backend (seat management, VDO.Ninja room generation, WebSocket)
- `public/index.html` - User page (where they pay/join)
- `public/overlay.html` - OBS overlay (just video boxes, transparent background)

## What's Working

✅ Seat management (6 max)
✅ VDO.Ninja integration (automatic camera capture)
✅ Real-time overlay updates via WebSocket
✅ Animated video boxes (fade in/out)
✅ 10-minute auto-expire
✅ Timer countdown
✅ Username labels
✅ Responsive grid (adjusts to 1-6 people)

## What's Next

### Add x402 USDC Payments

Currently anyone can join. To add payments:

1. Install x402:
```bash
npm install x402-express dotenv
```

2. Add to server.js:
```javascript
import { paymentMiddleware } from 'x402-express';

app.post('/api/join',
  paymentMiddleware(
    process.env.WALLET_ADDRESS,
    { 'POST /api/join': '$0.01' },
    { network: 'base-sepolia' }
  ),
  (req, res) => {
    // existing join logic
  }
);
```

3. Create `.env`:
```env
WALLET_ADDRESS=0xYourBaseAddress
```

### Deploy to Production

**Option 1: Railway**
1. Connect GitHub repo
2. Railway auto-detects Node.js
3. Set environment variables
4. Deploy
5. Get URL like: `your-app.railway.app`

**Option 2: Vercel**
1. `vercel deploy`
2. Set environment variables
3. Done

**Option 3: VPS (Digital Ocean, Linode)**
1. SSH into server
2. Clone repo
3. `npm install && npm start`
4. Use PM2 to keep it running
5. Point domain with nginx

## OBS Tips

**Best Settings:**
- Browser Source Width: 1920
- Browser Source Height: 1080
- FPS: 30
- Hardware Acceleration: ON
- Refresh browser when not active: OFF

**Layout:**
- Overlay covers full screen OR
- Position in corner like traditional facecam OR
- Bottom bar with multiple smaller boxes

**Chroma Key:**
Not needed! Transparent background by default.

## VDO.Ninja Notes

**What's happening:**
1. Server generates unique room ID
2. Push URL = User's camera broadcast
3. View URL = What appears in OBS
4. VDO.Ninja handles all WebRTC (peer-to-peer video)

**It's free!** VDO.Ninja is open source, no API keys needed.

**Quality:** Defaults to 720p, add `&quality=2` to URL for 1080p

**No accounts needed** - Works immediately

## Troubleshooting

**Video not showing in overlay:**
- Check VDO.Ninja link opened
- User granted camera permission
- Check browser console for errors
- VDO.Ninja sometimes takes 5-10 seconds to connect

**OBS overlay not updating:**
- Refresh browser source in OBS
- Check WebSocket connected (console)
- Restart server

**"No seats available":**
- Max 6 seats (change MAX_SEATS in server.js)
- Wait for someone to expire/leave

## Customization

**Change seat duration:**
```javascript
const SEAT_DURATION = 20 * 60 * 1000; // 20 minutes
```

**Change max seats:**
```javascript
const MAX_SEATS = 12;
```

**Change video quality:**
In overlay.html, modify iframe src:
```javascript
iframe.src = seat.viewUrl + '&quality=2'; // 1080p
```

**Change grid layout:**
Modify CSS in overlay.html `.grid` styles

**Change colors:**
Replace `#0ff` (cyan) with your brand color

## Next Steps

1. ✅ Test locally - Make sure video appears
2. 🔮 Add x402 payments - Require USDC to join
3. 🔮 Deploy to production - Get public URL
4. 🔮 Add Creator Coin - Holders get free access
5. 🔮 Custom branding - Your colors, logo

---

**You now have automatic on-stream camera boxes!** 🎥

VDO.Ninja does the hard WebRTC work. Your server just manages who's allowed on camera.
