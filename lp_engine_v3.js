// lp_engine_v3.js — ラインペイント描画エンジン V3
//
// 絵データ（LP_PICTURE）:
// {
//   format: "line_painter", version: 3,
//   width, height,          // 内部解像度（ドット）
//   pixelAspect,            // ドットの縦/横比（640x200 は 2、正方形ドットは 1）
//   paletteName, palette,   // 8色（"#rrggbb"）
//   colors,                 // 変換時に使うと指定した色（情報用）
//   clear,                  // 最初に画面を塗る色（紙の色）
//   drawMode,               // "palette" ならデジタルパレットの描画モードで再生する（省略時は通常）
//   palColors,              // palette モードの見せ色 ["描いている色", "それ以外の色"]（"#rrggbb"。省略時は青と黒）
//   ops: [
//     ["S", n]                              工程の印  1:線を引く 2:ベタ塗り 3:タイル塗り 4:線の引き直し
//     ["L", 色, [x0,y0,x1,y1,...], ...]     折れ線
//     ["D", 色, "base64"]                   折れ線（差分＋可変長整数で圧縮。V2 と同じ符号化）
//     ["P", 模様, 除外色, [x,y,...]]        塗りつぶし（模様は色番号の2次元配列。除外色のドットで止まる）
//     ["R", "base64"]                       塗りの並び（圧縮）。領域ごとに「ベタ → タイル」を続けて行う。
//                                           工程の印 2・3 を兼ねる
//   ]
// }
// V1・V2 の絵データもそのまま再生できる。
//
// 再生の速さは元の main.js を基準（×1）にしている:
//   線   … 1コマ(1/60秒)に 10 手、1 手が線分 1 本 → 毎秒 600 本（長い線分も 1 手で一息に出る）
//   塗り … 走査線 3 本ごとにタイマー(約4ms)で一息 → 毎秒およそ 750 本。種点から上下へ広がる

// 描画モード（画面に描く中身＝色番号は、どちらのモードでもまったく同じ。変わるのは見せ方だけ）
//   normal  … 色番号をそのままパレットの色で見せる
//   palette … PC-8801 のデジタルパレットの使い方を再現する。
//             8 つの色番号それぞれに、表示する色を自由に割り当てられることを使い、
//             ・描いている間は、いま描いている色番号だけを青 (0,0,1)、ほかは全部黒 (0,0,0) にする
//             ・色番号が切り替わると、前の色番号は黒に戻る（描いたものが見えなくなる）
//             ・同じ色番号を再び使うと、以前その番号で描いた所もいっしょに青く見える
//             ・最後に全部を黒にして一呼吸おき、既定のパレットに戻すと絵が現れる
//             タイル（2 色の市松）を塗るときは、直前のベタ塗りの色番号を青のままにする
//             （ベタで青く塗った所に、もう一方の色＝黒の点が打ち込まれていくのが見える）。
//             ベタなしで直接タイルを塗るときは、紙の色でない方（どちらも違えば 1 つ目）の色番号を青にする。

'use strict';
(function (global) {
	const LP3 = global.LP3 || (global.LP3 = {});

	LP3.PALETTES = {
		digital8: {
			name: 'デジタル8色',
			colors: ['#000000', '#0000ff', '#ff0000', '#ff00ff', '#00ff00', '#00ffff', '#ffff00', '#ffffff'],
		},
		db8: {
			name: 'DB8 (DawnBringer)',
			colors: ['#000000', '#55415f', '#646964', '#d77355', '#508cd7', '#64b964', '#e6c86e', '#dcf5ff'],
		},
	};
	LP3.STAGES = ['', '線を引く', 'ベタ塗り', 'タイル塗り', '線の引き直し'];
	LP3.LINES_PER_SEC = 600;
	LP3.RUNS_PER_SEC = 750;
	// デジタルパレットの描画モード
	LP3.PAL_BLUE = 0x0000ff;      // 描いている色番号に割り当てる色（既定）
	LP3.PAL_BLACK = 0x000000;     // それ以外の色番号に割り当てる色（既定）
	LP3.PAL_REVEAL_HOLD = 30;     // 描き終えてから絵を現すまで、全部「それ以外の色」で待つコマ数（1/60 秒単位）
	LP3.PAL_SWITCH_HOLD = 0;      // 色番号を切り替えるたびに全部「それ以外の色」で待つコマ数（0 = 待たない）
	// 見せ色に選べる色。PC-8801 のパレットに登録できるデジタル 8 色
	LP3.PAL_CHOICES = ['#000000', '#0000ff', '#ff0000', '#ff00ff', '#00ff00', '#00ffff', '#ffff00', '#ffffff'];
	LP3.PAL_DEFAULT = ['#0000ff', '#000000'];

	LP3.hexToInt = c => typeof c === 'number' ? c : parseInt(String(c).replace('#', ''), 16);

	//-----------------------------------------------------------------------------
	// 線分（標準のブレゼンハム法）
	// ・必ず始点と終点を通る。
	// ・いつも上（同じ高さなら左）の端から引くので、A→B と B→A で同じドットになる。
	// 変換側もこの関数で線を描き戻す。エンジンと変換で同じ関数を使うことが、
	// 「変換結果どおりに描ける」ことの前提。
	//-----------------------------------------------------------------------------
	LP3.linePixels = function (x1, y1, x2, y2, cb) {
		if (y1 > y2 || (y1 === y2 && x1 > x2)) { let t = x1; x1 = x2; x2 = t; t = y1; y1 = y2; y2 = t; }
		const dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1);
		const sx = (x2 > x1) ? 1 : -1, sy = (y2 > y1) ? 1 : -1;
		if (dx >= dy) {
			let E = 2 * dy - dx;
			for (let i = 0; i <= dx; i++) {
				cb(x1, y1);
				if (E > 0) { y1 += sy; E -= 2 * dx; }
				E += 2 * dy;
				x1 += sx;
			}
		} else {
			let E = 2 * dx - dy;
			for (let i = 0; i <= dy; i++) {
				cb(x1, y1);
				if (E > 0) { x1 += sx; E -= 2 * dy; }
				E += 2 * dx;
				y1 += sy;
			}
		}
	};

	//-----------------------------------------------------------------------------
	// 折れ線の圧縮（頂点の差分を符号付き可変長整数にして Base64）
	//-----------------------------------------------------------------------------
	LP3.packPolys = function (polys) {
		const bytes = [];
		const put = n => { do { const b = n & 127; n = Math.floor(n / 128); bytes.push(n ? b | 128 : b); } while (n); };
		const signed = n => n < 0 ? -n * 2 - 1 : n * 2;
		put(polys.length);
		for (const v of polys) {
			put(v.length / 2);
			let x = 0, y = 0;
			for (let i = 0; i < v.length; i += 2) {
				put(signed(v[i] - x)); put(signed(v[i + 1] - y));
				x = v[i]; y = v[i + 1];
			}
		}
		let raw = '';
		for (let i = 0; i < bytes.length; i += 8192) raw += String.fromCharCode(...bytes.slice(i, i + 8192));
		return btoa(raw);
	};
	LP3.unpackPolys = function (encoded) {
		const raw = atob(encoded);
		let pos = 0;
		const get = () => {
			let n = 0, scale = 1;
			for (let i = 0; i < 5; i++) {
				if (pos >= raw.length) throw new Error('折れ線データが途中で切れています');
				const b = raw.charCodeAt(pos++);
				n += (b & 127) * scale;
				if (!(b & 128)) return n;
				scale *= 128;
			}
			throw new Error('折れ線データの整数が長すぎます');
		};
		const signed = n => (n & 1) ? -(n + 1) / 2 : n / 2;
		const count = get(), polys = [];
		for (let p = 0; p < count; p++) {
			const len = get(), v = [];
			if (len < 1 || len > 200000) throw new Error('折れ線の頂点数が不正です');
			let x = 0, y = 0;
			for (let i = 0; i < len; i++) { x += signed(get()); y += signed(get()); v.push(x, y); }
			polys.push(v);
		}
		return polys;
	};

	//-----------------------------------------------------------------------------
	// 塗りの並びの圧縮。1 件 = { flat, a, b, rej, x, y }
	//   flat … ベタの色（-1 でベタなし）
	//   a, b … タイル（市松）の 2 色（a = -1 でタイルなし）。(x+y) が偶数のドットが a
	//   rej  … 除外色の配列
	//   x, y … 種点
	// 1 件を [flat+1] [タイル: 0 か a*8+b+1] [除外色のビット] [x の差分] [y の差分] で書く
	//-----------------------------------------------------------------------------
	LP3.packPaints = function (recs) {
		const bytes = [];
		const put = n => { do { const b = n & 127; n = Math.floor(n / 128); bytes.push(n ? b | 128 : b); } while (n); };
		const signed = n => n < 0 ? -n * 2 - 1 : n * 2;
		put(recs.length);
		let x = 0, y = 0;
		for (const r of recs) {
			bytes.push(r.flat + 1, r.a < 0 ? 0 : r.a * 8 + r.b + 1, r.rej.reduce((m, c) => m | (1 << c), 0));
			put(signed(r.x - x)); put(signed(r.y - y));
			x = r.x; y = r.y;
		}
		let raw = '';
		for (let i = 0; i < bytes.length; i += 8192) raw += String.fromCharCode(...bytes.slice(i, i + 8192));
		return btoa(raw);
	};
	LP3.unpackPaints = function (encoded) {
		const raw = atob(encoded);
		let pos = 0;
		const byte = () => { if (pos >= raw.length) throw new Error('塗りデータが途中で切れています'); return raw.charCodeAt(pos++); };
		const get = () => {
			let n = 0, scale = 1;
			for (let i = 0; i < 5; i++) { const b = byte(); n += (b & 127) * scale; if (!(b & 128)) return n; scale *= 128; }
			throw new Error('塗りデータの整数が長すぎます');
		};
		const signed = n => (n & 1) ? -(n + 1) / 2 : n / 2;
		const count = get(), recs = [];
		let x = 0, y = 0;
		for (let i = 0; i < count; i++) {
			const f = byte(), t = byte(), m = byte();
			x += signed(get()); y += signed(get());
			const rej = [];
			for (let c = 0; c < 8; c++) if (m & (1 << c)) rej.push(c);
			recs.push({ flat: f - 1, a: t ? (t - 1) >> 3 : -1, b: t ? (t - 1) & 7 : -1, rej, x, y });
		}
		return recs;
	};

	//-----------------------------------------------------------------------------
	class Engine
	//-----------------------------------------------------------------------------
	{
		// mode: 'normal' | 'palette'。省略すると絵データの drawMode に従う
		// palColors: palette モードの見せ色 [描いている色, それ以外の色]。省略すると絵データの palColors（なければ青と黒）
		constructor(pic, mode, palColors) {
			this.pic = pic;
			this.mode = mode || (pic.drawMode === 'palette' ? 'palette' : 'normal');
			const pc = palColors || pic.palColors || LP3.PAL_DEFAULT;
			this.palDraw = LP3.hexToInt(pc[0] ?? LP3.PAL_BLUE);
			this.palHide = LP3.hexToInt(pc[1] ?? LP3.PAL_BLACK);
			this.active = -1; // palette モードで、いま「描いている色」にしている色番号（-1 = 全部「それ以外の色」）
			this.w = pic.width | 0;
			this.h = pic.height | 0;
			this.palette = pic.palette.map(LP3.hexToInt);
			this.buf = new Uint8Array(this.w * this.h);     // 画面（パレット番号）
			this.stencil = new Uint8Array(this.w * this.h); // 今の塗りで塗ったドット
			this.it = null;
			this.done = false;
			this.stage = 0;   // 今の工程（"S" 命令で変わる）
			this.credit = 0;  // 時間の持ち越し（ミリ秒）
		}

		pset(x, y, c) {
			if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
			this.buf[y * this.w + x] = c;
		}

		line(x1, y1, x2, y2, c) {
			LP3.linePixels(x1, y1, x2, y2, (x, y) => this.pset(x, y, c));
		}

		// 塗りつぶし。元の main.js と同じ進み方をする:
		//  種を先入れ先出しで取り出す → 左右へ伸ばして 1 本塗る → 上下の行の塗れる区間ごとに種を置く。
		// 「塗れる」= 今回の塗りでまだ塗っておらず、除外色でもないドット。
		// 模様の中に除外色が入っていてもよい（今回塗ったドットは塗り済み印で見分ける）。
		*paint(x0, y0, pat, rej) {
			const w = this.w, h = this.h, buf = this.buf, st = this.stencil;
			if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h) return;
			const rj = new Uint8Array(256);
			for (const c of rej) rj[c] = 1;
			if (rj[buf[y0 * w + x0]]) return;

			st.fill(0);
			const ph = pat.length, pw = pat[0].length;
			const q = [x0, y0];
			let head = 0;
			while (head < q.length) {
				const sx = q[head++], sy = q[head++];
				const row = sy * w;
				if (st[row + sx] || rj[buf[row + sx]]) continue;

				let lx = sx;
				while (lx > 0 && !st[row + lx - 1] && !rj[buf[row + lx - 1]]) lx--;
				let rx = sx;
				while (rx < w - 1 && !st[row + rx + 1] && !rj[buf[row + rx + 1]]) rx++;

				const prow = pat[sy % ph];
				for (let x = lx; x <= rx; x++) {
					buf[row + x] = prow[x % pw];
					st[row + x] = 1;
				}

				for (let ny = sy - 1; ny <= sy + 1; ny += 2) {
					if (ny < 0 || ny >= h) continue;
					const nrow = ny * w;
					let inSpan = false;
					for (let x = lx; x <= rx; x++) {
						const k = nrow + x;
						if (!st[k] && !rj[buf[k]]) {
							if (!inSpan) { q.push(x, ny); inSpan = true; }
						} else inSpan = false;
					}
				}
				if (head > 65536 && head * 2 > q.length) { q.splice(0, head); head = 0; }
				yield 'P';
			}
		}

		// palette モード: 青にする色番号を切り替える。'W'（1 コマ待つ）を返すジェネレータ
		*activate(c) {
			if (this.mode !== 'palette' || c === this.active) return;
			if (this.active >= 0 && LP3.PAL_SWITCH_HOLD > 0) {
				this.active = -1;
				for (let i = 0; i < LP3.PAL_SWITCH_HOLD; i++) yield 'W';
			}
			this.active = c;
		}

		// タイル (a,b) を塗るときに青にする色番号
		tileActive(a, b, flat) {
			if (flat === a || flat === b) return flat; // 直前のベタの色
			return a === (this.pic.clear | 0) ? b : a;
		}

		// 線分 1 本ごとに 'L'、塗りの走査線 1 本ごとに 'P'、待ち 1 コマごとに 'W' を返す
		*run() {
			this.buf.fill(this.pic.clear | 0);
			this.stage = 0;
			this.active = -1;
			let lastFlat = null; // 直前がベタ塗りなら { c, x, y }
			for (const op of this.pic.ops) {
				const k = op[0];
				if (k === 'S') {
					this.stage = op[1] | 0;
				} else if (k === 'L' || k === 'D') {
					const c = op[1];
					lastFlat = null;
					yield* this.activate(c);
					const polys = k === 'D' ? LP3.unpackPolys(op[2]) : op.slice(2);
					for (const v of polys) {
						if (v.length === 2) { this.pset(v[0], v[1], c); yield 'L'; continue; }
						for (let i = 0; i + 3 < v.length; i += 2) {
							this.line(v[i], v[i + 1], v[i + 2], v[i + 3], c);
							yield 'L';
						}
					}
				} else if (k === 'P') {
					const pat = op[1], rej = op[2], s = op[3];
					const flat = pat.length === 1 && pat[0].length === 1;
					for (let i = 0; i + 1 < s.length; i += 2) {
						if (flat) {
							yield* this.activate(pat[0][0]);
							lastFlat = { c: pat[0][0], x: s[i], y: s[i + 1] };
						} else {
							const base = lastFlat && lastFlat.x === s[i] && lastFlat.y === s[i + 1] ? lastFlat.c : -1;
							yield* this.activate(this.tileActive(pat[0][0], pat[0][pat[0].length - 1], base));
							lastFlat = null;
						}
						yield* this.paint(s[i], s[i + 1], pat, rej);
					}
				} else if (k === 'R') {
					lastFlat = null;
					for (const r of LP3.unpackPaints(op[1])) {
						if (r.flat >= 0) { this.stage = 2; yield* this.activate(r.flat); yield* this.paint(r.x, r.y, [[r.flat]], r.rej); }
						if (r.a >= 0) { this.stage = 3; yield* this.activate(this.tileActive(r.a, r.b, r.flat)); yield* this.paint(r.x, r.y, [[r.a, r.b], [r.b, r.a]], r.rej); }
					}
				}
			}
			if (this.mode === 'palette') {
				// 全部を黒にして一呼吸おく。このあと done になると、既定のパレットに戻って絵が現れる
				this.active = -1;
				this.stage = 0;
				for (let i = 0; i < LP3.PAL_REVEAL_HOLD; i++) yield 'W';
			}
		}

		// いま画面に見せているパレット（色番号 → 色）
		displayPalette() {
			if (this.mode !== 'palette' || this.done) return this.palette;
			const p = new Array(this.palette.length).fill(this.palHide);
			if (this.active >= 0) p[this.active] = this.palDraw;
			return p;
		}

		start() {
			this.it = this.run();
			this.done = false;
			this.credit = 0;
		}

		// 経過時間 ms の分だけ進める。speed = 1 が元の main.js の速さ
		advance(ms, speed) {
			if (!this.it) this.start();
			if (this.done) return false;
			this.credit += ms * speed;
			const costL = 1000 / LP3.LINES_PER_SEC, costP = 1000 / LP3.RUNS_PER_SEC, costW = 1000 / 60;
			while (this.credit > 0) {
				const r = this.it.next();
				if (r.done) { this.done = true; this.credit = 0; return false; }
				this.credit -= r.value === 'P' ? costP : r.value === 'W' ? costW : costL;
			}
			return true;
		}

		runAll() {
			this.start();
			while (!this.it.next().done) { /* 一気に描く */ }
			this.done = true;
			return this.buf;
		}

		// 全体の所要時間（秒、speed = 1 のとき）
		static duration(pic, mode) {
			const e = new Engine(pic, mode);
			let L = 0, P = 0, Wt = 0;
			for (const u of e.run()) { if (u === 'P') P++; else if (u === 'W') Wt++; else L++; }
			return L / LP3.LINES_PER_SEC + P / LP3.RUNS_PER_SEC + Wt / 60;
		}

		blit(canvas) {
			if (canvas.width !== this.w) canvas.width = this.w;
			if (canvas.height !== this.h) canvas.height = this.h;
			const ctx = canvas.getContext('2d');
			const img = ctx.createImageData(this.w, this.h);
			LP3.indexToRGBA(this.buf, this.displayPalette(), img.data);
			ctx.putImageData(img, 0, 0);
		}
	}
	LP3.Engine = Engine;

	LP3.indexToRGBA = function (buf, paletteInts, out) {
		for (let i = 0, j = 0; i < buf.length; i++, j += 4) {
			const c = paletteInts[buf[i]];
			out[j] = (c >> 16) & 255; out[j + 1] = (c >> 8) & 255; out[j + 2] = c & 255; out[j + 3] = 255;
		}
		return out;
	};

	LP3.setDisplaySize = function (canvas, w, h, aspect, zoom) {
		canvas.style.width = (w * zoom) + 'px';
		canvas.style.height = Math.round(h * aspect * zoom) + 'px';
	};

	// 保存した picture の文字列 → オブジェクト
	LP3.parsePicture = function (text) {
		const a = text.indexOf('{'), b = text.lastIndexOf('}');
		return JSON.parse(text.slice(a, b + 1));
	};
})(typeof window !== 'undefined' ? window : globalThis);
