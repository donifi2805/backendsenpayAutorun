const admin = require('firebase-admin');

// --- 1. SETUP FIREBASE ---
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    }
} catch (error) {
    console.error("❌ GAGAL SETUP FIREBASE:", error.message);
    process.exit(1);
}

const db = admin.firestore();

// --- 2. KONFIGURASI ---
const KHFY_BASE_URL = "https://panel.khfy-store.com/api_v2";
const KHFY_AKRAB_URL = "https://panel.khfy-store.com/api_v3/cek_stock_akrab";
const ICS_BASE_URL = "https://api.ics-store.my.id/api/reseller";

// API KEYS (Prioritas dari Secrets GitHub)
const KHFY_KEY = process.env.KHFY_KEY || "8F1199C1-483A-4C96-825E-F5EBD33AC60A"; 
const ICS_KEY = process.env.ICS_KEY || "7274410f84b7e2810795810e879a4e0be8779c451d55e90e29d9bc174547ff77"; 

// 🔥 TELEGRAM CONFIG 🔥
const TG_TOKEN = "8515059248:AAGCbH_VlXUDsWn7ZVSIsFLEfL7qdi6Zw7k";
const TG_CHAT_ID = "7851913065";

const KHFY_SPECIAL_CODES = ['XLA14', 'XLA32', 'XLA39', 'XLA51', 'XLA65', 'XLA89'];
const PRODUCT_NAMES = { 'XLA14': 'Super Mini', 'XLA32': 'Mini', 'XLA39': 'Big', 'XLA51': 'Jumbo V2', 'XLA65': 'Jumbo', 'XLA89': 'Mega Big' };

// --- HELPERS ---
function getWIBTime() {
    return new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }).replace(/\./g, ':');
}

function esc(text) {
    if (!text) return "";
    return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function sendTelegramLog(message, isUrgent = false) {
    if (!TG_TOKEN || !TG_CHAT_ID) return;
    try {
        const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TG_CHAT_ID, text: message, parse_mode: 'HTML', disable_notification: !isUrgent })
        });
        const resJson = await res.json();
        if (!resJson.ok) console.error("❌ Telegram Error:", resJson.description);
    } catch (e) { console.error("❌ Gagal Fetch Telegram:", e.message); }
}

// --- STOCK LOGIC ---
async function getKHFYStock() {
    try {
        const res = await fetch(`${KHFY_BASE_URL}/list_product?api_key=${KHFY_KEY}`);
        const json = await res.json();
        const map = {};
        const list = json?.data || json || [];
        list.forEach(i => { map[i.kode_produk] = { gangguan: i.gangguan == 1, kosong: i.kosong == 1, status: i.status, code: i.kode_produk }; });
        return { list, map };
    } catch (e) { return { list: [], map: {} }; }
}

async function getICSStock() {
    try {
        const res = await fetch(`${ICS_BASE_URL}/products?apikey=${ICS_KEY}`, { headers: { 'Authorization': `Bearer ${ICS_KEY}`, 'Accept': 'application/json' } });
        const json = await res.json();
        const map = {};
        const list = json?.ready || json?.data || json || [];
        list.forEach(i => { map[i.code] = { gangguan: i.status === 'gangguan', kosong: (i.status === 'empty' || i.stock === 0), stock: i.stock || 0, code: i.code }; });
        return { list, map };
    } catch (e) { return { list: [], map: {} }; }
}

async function getV3Slots() {
    try {
        const res = await fetch(KHFY_AKRAB_URL);
        const json = await res.json();
        const map = {};
        if (json?.ok) json.data.forEach(i => { map[i.type] = parseInt(i.sisa_slot || 0); });
        return map;
    } catch (e) { return null; }
}

// --- MAIN RUNNER ---
async function runWorker() {
    console.log("🚀 WORKER STARTING...");
    
    try {
        // Ambil antrian PENDING sesuai paneladmin (11).html
        const snapshot = await db.collection('po_akrab').where('status', '==', 'PENDING').orderBy('timestamp', 'asc').limit(20).get();

        const [khfy, ics, v3] = await Promise.all([getKHFYStock(), getICSStock(), getV3Slots()]);

        let report = `🤖 <b>AUTORUN SENPAYMENT</b> [${getWIBTime()}]\n`;
        report += `━━━━━━━━━━━━━━━━━━\n`;
        
        // Slot V3
        report += `📊 <b>SLOT V3 AKRAB</b>\n`;
        KHFY_SPECIAL_CODES.forEach(c => {
            const s = v3?.[c] ?? 0;
            report += `${s > 3 ? '🟢' : '🔴'} ${esc(PRODUCT_NAMES[c] || c)}: <b>${s}</b>\n`;
        });

        // 2 Kolom ICS
        report += `\n📡 <b>SERVER ICS</b>\n`;
        const icsList = ics.list.filter(i => i.code && !i.code.toLowerCase().includes('tes')).sort((a,b) => a.code.localeCompare(b.code));
        for(let i=0; i<icsList.length; i+=2) {
            const it1 = icsList[i];
            const it2 = icsList[i+1];
            const s1 = `${it1.gangguan ? '⛔' : (it1.kosong ? '🔴' : '✅')} ${esc(it1.code)}:<b>${it1.stock||0}</b>`;
            const s2 = it2 ? `${it2.gangguan ? '⛔' : (it2.kosong ? '🔴' : '✅')} ${esc(it2.code)}:<b>${it2.stock||0}</b>` : "";
            report += `${s1}  ${s2}\n`;
        }

        await sendTelegramLog(report + `━━━━━━━━━━━━━━━━━━`);

        if (snapshot.empty) {
            console.log("ℹ️ Antrian kosong.");
            return;
        }

        for (const docSnap of snapshot.docs) {
            const po = docSnap.data();
            const poID = docSnap.id;
            const server = po.provider || 'KHFY';
            
            // Cek Stok
            let skip = false;
            if (server === 'KHFY' && KHFY_SPECIAL_CODES.includes(po.kode_produk)) {
                if ((v3?.[po.kode_produk] ?? 0) <= 3) skip = true;
            } else if (server === 'KHFY' && khfy.map[po.kode_produk]?.kosong) skip = true;
            else if (server === 'ICS' && ics.map[po.kode_produk]?.kosong) skip = true;

            if (skip) {
                console.log(`⏩ Skip ${po.kode_produk}: Stok Kosong`);
                continue;
            }

            // Hit API
            console.log(`🎯 Eksekusi: ${po.kode_produk} ke ${po.tujuan}`);
            let url = (server === 'ICS') ? `${ICS_BASE_URL}/trx?apikey=${ICS_KEY}` : `${KHFY_BASE_URL}/trx?api_key=${KHFY_KEY}&produk=${po.kode_produk}&tujuan=${po.tujuan}&reff_id=${po.trx_id}`;
            
            let result;
            try {
                const req = await fetch(url, server === 'ICS' ? { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ product_code: po.kode_produk, dest_number: po.tujuan, ref_id_custom: po.trx_id }) } : {});
                result = await req.json();
            } catch(e) { result = { message: e.message }; }

            // Sesuai permintaan: Hanya PENDING dan BERHASIL
            let finalStat = 'PENDING';
            const raw = JSON.stringify(result).toLowerCase();
            if (raw.includes('sukses') || raw.includes('berhasil')) finalStat = 'BERHASIL';

            // Update DB
            await db.collection('po_akrab').doc(poID).update({ 
                status: finalStat, 
                sn: result.data?.sn || result.sn || '-', 
                pesan_api: result.message || 'Updated',
                raw_json: JSON.stringify(result)
            });

            // Update Riwayat
            const riwayat = await db.collection('users').doc(po.uid).collection('riwayat_transaksi').where('trx_id', '==', po.trx_id).get();
            riwayat.forEach(async (d) => { await d.ref.update({ status: finalStat, sn: result.data?.sn || '-' }); });

            await sendTelegramLog(`✅ <b>TRX ${finalStat}</b>\n👤 ${esc(po.username)}\n📦 ${esc(po.produk)}\n📱 <code>${po.tujuan}</code>`);
            await new Promise(r => setTimeout(r, 5000));
        }

    } catch (e) {
        console.error("❌ CRITICAL:", e.message);
        await sendTelegramLog(`⚠️ <b>CRITICAL ERROR:</b>\n<code>${esc(e.message)}</code>`);
    } finally {
        process.exit(0);
    }
}

runWorker();