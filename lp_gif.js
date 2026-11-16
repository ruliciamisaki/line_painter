// lp_gif.js — 描画の様子を GIF アニメにする（lp_engine.js の後に読み込む）
//
//   const bytes = await LP3.makeGif(絵データ, {
//     speed: 1,          // 再生の速さ（1 = 元の main.js の速さ）
//     fps: 20,           // 1 秒あたりのコマ数（100 を割り切れる数がよい: 10, 20, 25, 50）
//     zoom: 1,           // 拡大率。縦長ドット（pixelAspect 2）は縦を 2 倍にして、見た目どおりの縦横比にする
//     mode, palColors,   // 見せ方（省略すると絵データの指定どおり）。LP3.Engine と同じ
//     holdSec: 2,        // 描き終えた絵を見せておく秒数（そのあと最初から繰り返す）
//     loop: true,        // 繰り返すか
//     onProgress: r => {},  // 0〜1
//   });
//   → Uint8Array（GIF89a）
//
// しくみ:
// - エンジンを 1 コマずつ進め、画面（色番号）とそのとき見せているパレットから、1 コマの絵を作る。
// - 前のコマと違うドットを囲む四角だけを書き出す。四角の中の変わっていないドットは透明にする。
// - 何も変わらないコマは書き出さず、前のコマの表示時間を延ばす。
// - 色の表は、絵の 8 色とデジタルパレットの見せ色 2 色。全部で 16 色以下に収まる。
(function (root) {
	'use strict';
	const LP3 = root.LP3;

	// LZW 圧縮（GIF の画像データ。255 バイトごとの区切りも付ける）
	function lzw(pix, minCode, out) {
		out.push(minCode);
		const clear = 1 << minCode, eoi = clear + 1;
		let size = minCode + 1, next = eoi + 1;
		const dict = new Map();
		const block = [];
		let acc = 0, bits = 0;
		const emit = code => {
			acc |= code << bits; bits += size;
			while (bits >= 8) {
				block.push(acc & 255); acc >>>= 8; bits -= 8;
				if (block.length === 255) { out.push(255); for (const b of block) out.push(b); block.length = 0; }
			}
		};
		emit(clear);
		let prefix = pix[0];
		for (let i = 1; i < pix.length; i++) {
			const k = pix[i], key = prefix * 256 + k;
			const hit = dict.get(key);
			if (hit !== undefined) { prefix = hit; continue; }
			emit(prefix);
			if (next < 4096) {
				dict.set(key, next++);
				if (next > (1 << size) && size < 12) size++;
			} else {
				emit(clear);
				dict.clear(); size = minCode + 1; next = eoi + 1;
			}
			prefix = k;
		}
		emit(prefix);
		emit(eoi);
		if (bits > 0) block.push(acc & 255);
		if (block.length) { out.push(block.length); for (const b of block) out.push(b); }
		out.push(0);
	}

	LP3.makeGif = async function (pic, opt = {}) {
		const speed = opt.speed || 1, fps = opt.fps || 20, zoom = Math.max(1, opt.zoom | 0 || 1);
		const holdSec = opt.holdSec ?? 2, loop = opt.loop !== false;
		const e = new LP3.Engine(pic, opt.mode, opt.palColors);
		const W = e.w, H = e.h;
		const ay = Math.max(1, Math.round(pic.pixelAspect || 1));
		const sx = zoom, sy = zoom * ay;               // 1 ドットを横 sx・縦 sy に広げる
		const OW = W * sx, OH = H * sy;

		// 色の表: 絵の 8 色 + 見せ色。重複はまとめる。最後の 1 枠を透明に使う
		const colors = [];
		const indexOf = c => { let i = colors.indexOf(c); if (i < 0) { i = colors.length; colors.push(c); } return i; };
		e.palette.forEach(indexOf);
		if (e.mode === 'palette') { indexOf(e.palDraw); indexOf(e.palHide); }
		let bitsC = 1; while ((1 << bitsC) < colors.length + 1) bitsC++;
		const tableN = 1 << bitsC, TRANS = colors.length;
		const minCode = Math.max(2, bitsC);

		const frames = [];        // { x, y, w, h, pix, cs, trans }
		const cur = new Uint8Array(W * H), prev = new Uint8Array(W * H);
		const map = new Uint8Array(256);
		const csPerFrame = 100 / fps;
		let tAcc = 0, first = true;

		const capture = () => {
			const dp = e.displayPalette();
			for (let i = 0; i < dp.length; i++) map[i] = indexOf(dp[i]);
			let x0 = W, y0 = H, x1 = -1, y1 = -1;
			for (let y = 0, i = 0; y < H; y++) for (let x = 0; x < W; x++, i++) {
				const v = map[e.buf[i]];
				cur[i] = v;
				if (first || v !== prev[i]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
			}
			if (x1 < 0) return false; // 変化なし
			const w = x1 - x0 + 1, h = y1 - y0 + 1;
			const pix = new Uint8Array(w * sx * h * sy);
			let k = 0;
			for (let y = y0; y <= y1; y++) {
				const rowStart = k;
				for (let x = x0; x <= x1; x++) {
					const i = y * W + x;
					const v = !first && cur[i] === prev[i] ? TRANS : cur[i];
					for (let r = 0; r < sx; r++) pix[k++] = v;
				}
				for (let r = 1; r < sy; r++) { pix.copyWithin(k, rowStart, rowStart + w * sx); k += w * sx; }
			}
			frames.push({ x: x0 * sx, y: y0 * sy, w: w * sx, h: h * sy, pix, cs: 0, trans: !first });
			prev.set(cur);
			first = false;
			return true;
		};
		// 時刻を積み上げて、コマの表示時間（1/100 秒単位）がずれないように丸める
		const addTime = cs => {
			const f = frames[frames.length - 1];
			const before = Math.round(tAcc); tAcc += cs;
			f.cs += Math.round(tAcc) - before;
		};

		e.start();
		capture();
		const total = LP3.Engine.duration(pic, e.mode) * 1000 / speed;
		let t = 0, n = 0;
		for (;;) {
			const more = e.advance(1000 / fps, speed);
			t += 1000 / fps;
			addTime(csPerFrame);
			capture();
			if (!more) break;
			if (++n % 40 === 0) {
				if (opt.onProgress) opt.onProgress(Math.min(0.95, t / Math.max(1, total)));
				await new Promise(r => setTimeout(r, 0));
			}
		}
		addTime(Math.max(2, holdSec * 100));
		if (loop && frames[frames.length - 1].cs < 2) frames[frames.length - 1].cs = 2;

		// 書き出し
		const out = [];
		const u16 = v => { out.push(v & 255, (v >> 8) & 255); };
		for (const ch of 'GIF89a') out.push(ch.charCodeAt(0));
		u16(OW); u16(OH);
		out.push(0x80 | ((bitsC - 1) << 4) | (bitsC - 1), 0, 0);
		for (let i = 0; i < tableN; i++) {
			const c = colors[i] ?? 0;
			out.push((c >> 16) & 255, (c >> 8) & 255, c & 255);
		}
		if (loop) {
			out.push(0x21, 0xff, 11);
			for (const ch of 'NETSCAPE2.0') out.push(ch.charCodeAt(0));
			out.push(3, 1, 0, 0, 0);
		}
		for (let fi = 0; fi < frames.length; fi++) {
			const f = frames[fi];
			// 表示時間 0 のコマは、ブラウザによって 0.1 秒に延ばされるので、最低 1/100 秒にする
			const cs = Math.max(1, Math.min(65535, f.cs));
			out.push(0x21, 0xf9, 4, (1 << 2) | (f.trans ? 1 : 0)); u16(cs); out.push(f.trans ? TRANS : 0, 0);
			out.push(0x2c); u16(f.x); u16(f.y); u16(f.w); u16(f.h); out.push(0);
			lzw(f.pix, minCode, out);
			if (fi % 20 === 19) {
				if (opt.onProgress) opt.onProgress(0.95 + 0.05 * fi / frames.length);
				await new Promise(r => setTimeout(r, 0));
			}
		}
		out.push(0x3b);
		if (opt.onProgress) opt.onProgress(1);
		return new Uint8Array(out);
	};
})(typeof window !== 'undefined' ? window : globalThis);
