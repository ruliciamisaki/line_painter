// lp_convert_v3.js — 画像 → ラインペイント絵データ変換 V3
//
// 絵を、昔のお絵かきと同じ 4 つの工程の命令列にする。
//   1. 線を引く       … 絵全体の輪郭を線画として引く（主線＋色の境目）
//   2. ベタ塗り       … 線で閉じた範囲を単色で塗る
//   3. タイル塗り     … 市松の領域を、ベタの上からタイルで塗り直す
//   4. 線の引き直し   … 塗りの都合で仮の色で引いた線を、本来の色で引き直す
//
// 中心になる考え方は「線の網」。
//   主線（暗い線）と、色の境目（隣り合うドットの色が違う所）を 1 枚の線の絵にまとめ、
//   1 ドット幅に細くして、分岐点から分岐点までを 1 本のストロークとして扱う。
//   主線が途切れていても、色の境目が線になるので、領域は必ず閉じる。
//   頂点を間引いたストロークを描き戻したものを正式な線とし、領域はそこから求め直す。
//   だから、どれだけ間引いても「塗りが漏れる」ことはなく、エンジンは変換結果どおりに描く。

'use strict';
(function (global) {
	const LP3 = global.LP3;
	const C = LP3.convert = {};

	//=============================================================================
	// 色
	//=============================================================================
	const S2L = new Float32Array(256);
	for (let i = 0; i < 256; i++) {
		const c = i / 255;
		S2L[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
	}
	const toLin = c => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

	function lin2oklab(r, g, b, out, o) {
		const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
		const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
		const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
		out[o] = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
		out[o + 1] = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
		out[o + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
	}

	// 候補の色 = 使う色の単色と、そのうち 2 色の市松（8 色なら 36 色）。
	// 市松の見かけの色は、表示上の RGB コードの平均で評価する（V2 で採用。赤＋黄は #FF8000）。
	// 線形 RGB の平均だと橙が黄寄りに見積もられ、全体が灰色に寄りやすかった。
	// 補色どうしの市松（黄＋青など）は計算上は灰色になるが、本当に無彩色の所では白黒を優先する。
	// 色数が少ないほど、色合いより明るさを重く見る（wC が色合いの重み）。
	const CHROMA_WEIGHT = [0, 0, 0.15, 0.3, 0.5, 0.75, 1, 1.2, 1.4];
	C.buildCandidates = function (paletteInts, sel) {
		sel = sel && sel.length ? sel.slice().sort((a, b) => a - b) : [0, 1, 2, 3, 4, 5, 6, 7];
		const rgb = paletteInts.map(c => [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255]);
		const cands = [];
		for (let i = 0; i < sel.length; i++) {
			for (let j = i; j < sel.length; j++) {
				const a = sel[i], b = sel[j];
				const lab = new Float32Array(3);
				lin2oklab(toLin((rgb[a][0] + rgb[b][0]) / 2), toLin((rgb[a][1] + rgb[b][1]) / 2), toLin((rgb[a][2] + rgb[b][2]) / 2), lab, 0);
				const pairChroma = Math.max(...rgb[a]) - Math.min(...rgb[a]) + Math.max(...rgb[b]) - Math.min(...rgb[b]);
				const extra = a !== b && Math.hypot(lab[1], lab[2]) < 0.025 && pairChroma > 1.5 ? 0.012 : 0;
				cands.push({ a, b, solid: a === b, lab, extra });
			}
		}
		cands.sel = sel;
		cands.wC = CHROMA_WEIGHT[sel.length];
		// 単色の明るさ（パレット番号 → L）
		cands.L = [];
		for (const c of cands) if (c.solid) cands.L[c.a] = c.lab[0];
		return cands;
	};

	function nearestCand(L, A, B, cands, penalty) {
		let best = 0, bd = Infinity;
		const wC = cands.wC === undefined ? 1 : cands.wC;
		for (let k = 0; k < cands.length; k++) {
			const c = cands[k].lab;
			const d0 = L - c[0], d1 = A - c[1], d2 = B - c[2];
			let d = Math.sqrt(d0 * d0 + wC * (d1 * d1 + d2 * d2));
			if (!cands[k].solid) d += penalty + (cands[k].extra || 0);
			if (d < bd) { bd = d; best = k; }
		}
		return best;
	}

	//=============================================================================
	// 画像の縮小（ブラウザ専用）
	//=============================================================================
	// 作業用解像度は W × round(H×aspect)（正方形ドット換算）。
	// 縮小は面積平均で自前で行う（ブラウザ任せだと網点がモアレになる）。
	// deDither: 平均する幅を最低 2 ドットにして、1 ドット周期の網点・市松・縞を均す。
	//   このときは RGB コード値のまま平均する。候補の市松を「コード値の平均」で見積もっているので、
	//   入力の網点も同じ物差しで均さないと食い違う（白＋黄の網点が白と判定される、など）。
	//   deDither を切ると、物理的に正しい線形 RGB で平均する。
	function axisWeights(nOut, d0, dLen, s0, sLen, sSize, minFoot) {
		const res = new Array(nOut);
		const foot = Math.max(minFoot, sLen / dLen);
		for (let o = 0; o < nOut; o++) {
			const t = o + 0.5;
			if (t < d0 || t > d0 + dLen) { res[o] = null; continue; }
			const u = s0 + (t - d0) / dLen * sLen;
			const a = Math.max(0, u - foot / 2), b = Math.min(sSize, u + foot / 2);
			const i0 = Math.floor(a), i1 = Math.max(i0 + 1, Math.ceil(b));
			const w = [];
			let sum = 0;
			for (let i = i0; i < i1; i++) {
				const ov = Math.max(0, Math.min(b, i + 1) - Math.max(a, i));
				w.push(ov); sum += ov;
			}
			if (sum <= 0) { w.fill(0); w[0] = 1; sum = 1; }
			res[o] = { i0, w: w.map(v => v / sum) };
		}
		return res;
	}

	C.resample = function (img, W, H, aspect, fit, deDither) {
		const Hw = Math.max(1, Math.round(H * aspect));
		const sw = img.naturalWidth || img.width, sh = img.naturalHeight || img.height;
		let sx = 0, sy = 0, sW = sw, sH = sh, dx = 0, dy = 0, dW = W, dH = Hw;
		const tA = W / Hw, sA = sw / sh;
		if (fit === 'cover') {
			if (sA > tA) { sW = sh * tA; sx = (sw - sW) / 2; } else { sH = sw / tA; sy = (sh - sH) / 2; }
		} else if (fit === 'contain') {
			if (sA > tA) { dH = W / sA; dy = (Hw - dH) / 2; } else { dW = Hw * sA; dx = (W - dW) / 2; }
		}
		let src = img, cx = sx, cy = sy, cw = sW, ch = sH;
		while (cw > dW * 4 && ch > dH * 4) {
			const c = document.createElement('canvas');
			c.width = Math.max(1, Math.round(cw / 2));
			c.height = Math.max(1, Math.round(ch / 2));
			const g = c.getContext('2d');
			g.imageSmoothingEnabled = true;
			g.imageSmoothingQuality = 'high';
			g.drawImage(src, cx, cy, cw, ch, 0, 0, c.width, c.height);
			src = c; cx = 0; cy = 0; cw = c.width; ch = c.height;
		}
		const ix = Math.floor(cx), iy = Math.floor(cy);
		const iw = Math.max(1, Math.ceil(cx + cw) - ix), ih = Math.max(1, Math.ceil(cy + ch) - iy);
		const sc = document.createElement('canvas');
		sc.width = iw; sc.height = ih;
		const sg = sc.getContext('2d', { willReadFrequently: true });
		sg.drawImage(src, ix, iy, iw, ih, 0, 0, iw, ih);
		const sd = sg.getImageData(0, 0, iw, ih).data;
		const sl = new Float32Array(iw * ih * 3);
		for (let i = 0, j = 0; i < iw * ih; i++, j += 4) {
			const a = sd[j + 3] / 255;
			if (deDither) {
				sl[i * 3] = sd[j] / 255 * a + (1 - a); sl[i * 3 + 1] = sd[j + 1] / 255 * a + (1 - a); sl[i * 3 + 2] = sd[j + 2] / 255 * a + (1 - a);
			} else {
				sl[i * 3] = S2L[sd[j]] * a + (1 - a); sl[i * 3 + 1] = S2L[sd[j + 1]] * a + (1 - a); sl[i * 3 + 2] = S2L[sd[j + 2]] * a + (1 - a);
			}
		}
		const minFoot = deDither ? 2 : 1;
		const wx = axisWeights(W, dx, dW, cx - ix, cw, iw, minFoot);
		const wy = axisWeights(Hw, dy, dH, cy - iy, ch, ih, minFoot);
		const tmp = new Float32Array(ih * W * 3);
		for (let y = 0; y < ih; y++) {
			for (let x = 0; x < W; x++) {
				const o = (y * W + x) * 3, k = wx[x];
				if (!k) { tmp[o] = tmp[o + 1] = tmp[o + 2] = 1; continue; }
				let r = 0, g = 0, b = 0;
				for (let t = 0; t < k.w.length; t++) {
					const s = (y * iw + k.i0 + t) * 3, v = k.w[t];
					r += sl[s] * v; g += sl[s + 1] * v; b += sl[s + 2] * v;
				}
				tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b;
			}
		}
		const lin = new Float32Array(Hw * W * 3);
		for (let y = 0; y < Hw; y++) {
			const k = wy[y];
			for (let x = 0; x < W; x++) {
				const o = (y * W + x) * 3;
				if (!k || !wx[x]) { lin[o] = lin[o + 1] = lin[o + 2] = 1; continue; }
				let r = 0, g = 0, b = 0;
				for (let t = 0; t < k.w.length; t++) {
					const s = ((k.i0 + t) * W + x) * 3, v = k.w[t];
					r += tmp[s] * v; g += tmp[s + 1] * v; b += tmp[s + 2] * v;
				}
				lin[o] = r; lin[o + 1] = g; lin[o + 2] = b;
			}
		}
		if (deDither) for (let i = 0; i < lin.length; i++) lin[i] = toLin(lin[i]); // 以後は線形 RGB で扱う
		return { lin, W, Hw };
	};

	// 線形 RGB → 表示用のコード値（0〜1）
	const toCode = v => { v = Math.min(1, Math.max(0, v)); return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055; };

	// 縮小した画像を canvas にする（「元画像」タブ用）
	let CODE8 = null; // 線形 RGB（0〜1 を 4096 段）→ 表示用の 8 ビット値
	function linToCanvas(lin, W, Hw) {
		if (!CODE8) { CODE8 = new Uint8Array(4097); for (let i = 0; i <= 4096; i++) CODE8[i] = Math.round(255 * toCode(i / 4096)); }
		const out = document.createElement('canvas');
		out.width = W; out.height = Hw;
		const og = out.getContext('2d'), id = og.createImageData(W, Hw), d = id.data;
		const q = v => CODE8[v <= 0 ? 0 : v >= 1 ? 4096 : (v * 4096 + 0.5) | 0];
		for (let i = 0, j = 0; i < W * Hw * 3; i += 3, j += 4) { d[j] = q(lin[i]); d[j + 1] = q(lin[i + 1]); d[j + 2] = q(lin[i + 2]); d[j + 3] = 255; }
		og.putImageData(id, 0, 0);
		return out;
	}
	C.linToCanvas = linToCanvas;

	// 原画の色補正。adj = { r, g, b, sat, bright, contrast }（どれも -100〜100、0 で変化なし）
	// 画像編集ソフトと同じく、表示用のコード値の上で行う。順番は R・G・B → 明るさ → コントラスト → 彩度。
	//   R・G・B      … その成分を 0〜2 倍する
	//   明るさ       … 全体に -0.5〜+0.5 を足す
	//   コントラスト … 中間の明るさ(0.5)を軸に 0〜3 倍に広げる
	//   彩度         … 明るさ（輝度）を保ったまま、色みを 0〜3 倍にする
	C.adjustColors = function (lin, adj) {
		const a = adj || {};
		const zero = !['r', 'g', 'b', 'sat', 'bright', 'contrast'].some(k => a[k]);
		if (zero) return lin;
		const gain = v => 1 + (v || 0) / 100;
		const wide = v => (v || 0) >= 0 ? 1 + (v || 0) / 50 : 1 + (v || 0) / 100;
		const gr = gain(a.r), gg = gain(a.g), gb = gain(a.b);
		const add = (a.bright || 0) / 200, kc = wide(a.contrast), ks = wide(a.sat);
		const out = new Float32Array(lin.length);
		// 累乗の計算は表で引く（スライダーを動かすたびに全ドットで行うので、速さが効く）
		if (!C._lut) {
			const c = new Float32Array(4097), l = new Float32Array(4097);
			for (let i = 0; i <= 4096; i++) { c[i] = toCode(i / 4096); l[i] = toLin(i / 4096); }
			C._lut = { c, l };
		}
		const LC = C._lut.c, LL = C._lut.l;
		const code = v => LC[v <= 0 ? 0 : v >= 1 ? 4096 : (v * 4096 + 0.5) | 0];
		const back = v => LL[v <= 0 ? 0 : v >= 1 ? 4096 : (v * 4096 + 0.5) | 0];
		for (let i = 0; i < lin.length; i += 3) {
			let r = code(lin[i]) * gr + add, g = code(lin[i + 1]) * gg + add, b = code(lin[i + 2]) * gb + add;
			r = (r - 0.5) * kc + 0.5; g = (g - 0.5) * kc + 0.5; b = (b - 0.5) * kc + 0.5;
			const y = 0.299 * r + 0.587 * g + 0.114 * b;
			r = y + (r - y) * ks; g = y + (g - y) * ks; b = y + (b - y) * ks;
			out[i] = back(r); out[i + 1] = back(g); out[i + 2] = back(b);
		}
		return out;
	};

	function workLuminance(lin, W, Hw) {
		const N = W * Hw, L = new Float32Array(N), t = new Float32Array(3);
		for (let i = 0; i < N; i++) { lin2oklab(lin[i * 3], lin[i * 3 + 1], lin[i * 3 + 2], t, 0); L[i] = t[0]; }
		return L;
	}

	function targetLab(lin, W, Hw, H) {
		const lab = new Float32Array(W * H * 3);
		for (let y = 0; y < H; y++) {
			const y0 = Math.floor(y * Hw / H), y1 = Math.max(y0 + 1, Math.floor((y + 1) * Hw / H));
			for (let x = 0; x < W; x++) {
				let r = 0, g = 0, b = 0;
				for (let yy = y0; yy < y1; yy++) { const j = (yy * W + x) * 3; r += lin[j]; g += lin[j + 1]; b += lin[j + 2]; }
				const n = y1 - y0;
				lin2oklab(r / n, g / n, b / n, lab, (y * W + x) * 3);
			}
		}
		return lab;
	}

	// 輪郭を残す平滑化（バイラテラルフィルタ）
	function bilateral(lab, W, H, aspect, iters, sigmaR) {
		const radius = 2, rx = radius, ry = Math.max(1, Math.round(radius / aspect));
		const offs = [], sS = radius * 0.8 + 0.5;
		for (let dy = -ry; dy <= ry; dy++) for (let dx = -rx; dx <= rx; dx++) {
			offs.push([dx, dy, Math.exp(-(dx * dx + (dy * aspect) * (dy * aspect)) / (2 * sS * sS))]);
		}
		const inv2r = 1 / (2 * sigmaR * sigmaR);
		// 色の差の重み exp(-d²/2σ²) は表で引く（d² が 16σ² を超えたら重み 0 とみなす）
		const TN = 2048, tmax = 16 * sigmaR * sigmaR, tscale = TN / tmax, wtab = new Float32Array(TN + 1);
		for (let i = 0; i < TN; i++) wtab[i] = Math.exp(-(i / tscale) * inv2r);
		let src = lab, dst = new Float32Array(lab.length);
		for (let it = 0; it < iters; it++) {
			for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
				const p = (y * W + x) * 3, L0 = src[p], A0 = src[p + 1], B0 = src[p + 2];
				let sw = 0, sL = 0, sA = 0, sB = 0;
				for (let k = 0; k < offs.length; k++) {
					const xx = x + offs[k][0], yy = y + offs[k][1];
					if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
					const q = (yy * W + xx) * 3;
					const d0 = src[q] - L0, d1 = src[q + 1] - A0, d2 = src[q + 2] - B0;
					const dd = (d0 * d0 + d1 * d1 + d2 * d2) * tscale;
					if (dd >= TN) continue;
					const w = offs[k][2] * wtab[dd | 0];
					sw += w; sL += w * src[q]; sA += w * src[q + 1]; sB += w * src[q + 2];
				}
				dst[p] = sL / sw; dst[p + 1] = sA / sw; dst[p + 2] = sB / sw;
			}
			const t = src === lab ? new Float32Array(lab.length) : src;
			src = dst; dst = t;
		}
		return src;
	}

	// 使う色が少ないとき、画像の明るさの幅を、使う色で出せる明るさの幅に引き伸ばす
	function remapLightness(lab, N, cands) {
		const Ls = new Float32Array(N);
		for (let p = 0; p < N; p++) Ls[p] = lab[p * 3];
		Ls.sort();
		const lo = Ls[Math.floor(N * 0.01)], hi = Ls[Math.floor(N * 0.99)];
		if (hi - lo < 1e-3) return lab;
		let cMin = Infinity, cMax = -Infinity;
		for (const c of cands) { cMin = Math.min(cMin, c.lab[0]); cMax = Math.max(cMax, c.lab[0]); }
		const out = lab.slice();
		for (let p = 0; p < N; p++) {
			const t = Math.min(1, Math.max(0, (lab[p * 3] - lo) / (hi - lo)));
			out[p * 3] = cMin + t * (cMax - cMin);
		}
		return out;
	}

	// 1 色の線画用: 明るさを k 段に分ける（境目は 1 次元 k-means で、分布の谷に置く）
	function toneLabels(lab, N, k) {
		const Ls = new Float32Array(N);
		for (let p = 0; p < N; p++) Ls[p] = lab[p * 3];
		const sorted = Ls.slice().sort();
		const centers = [];
		for (let i = 0; i < k; i++) centers.push(sorted[Math.floor(N * (i + 0.5) / k)]);
		const hist = new Float64Array(256);
		for (let p = 0; p < N; p++) hist[Math.min(255, Math.max(0, Math.round(Ls[p] * 255)))]++;
		for (let it = 0; it < 30; it++) {
			const s = new Float64Array(k), c = new Float64Array(k);
			for (let v = 0; v < 256; v++) {
				if (!hist[v]) continue;
				const L = v / 255;
				let best = 0;
				for (let j = 1; j < k; j++) if (Math.abs(L - centers[j]) < Math.abs(L - centers[best])) best = j;
				s[best] += L * hist[v]; c[best] += hist[v];
			}
			for (let j = 0; j < k; j++) if (c[j]) centers[j] = s[j] / c[j];
			centers.sort((a, b) => a - b);
		}
		const th = [];
		for (let i = 1; i < k; i++) th.push((centers[i - 1] + centers[i]) / 2);
		const labels = new Uint8Array(N);
		for (let p = 0; p < N; p++) { let l = 0; while (l < th.length && Ls[p] > th[l]) l++; labels[p] = l; }
		const cands = centers.map((L, l) => ({ a: l, b: l, solid: true, lab: new Float32Array([L, 0, 0]) }));
		cands.sel = cands.map(c => c.a);
		cands.wC = 0;
		return { labels, cands };
	}

	//=============================================================================
	// ラベル地図（各ドットがどの候補色か）の操作
	//=============================================================================
	// 4 連結の連結成分。keys === skip のドットは対象外
	function cc4(keys, W, H, skip) {
		const N = W * H;
		const comp = new Int32Array(N).fill(-1), stack = new Int32Array(N);
		const sizes = [], keyOf = [], first = [];
		let n = 0;
		for (let s = 0; s < N; s++) {
			if (comp[s] >= 0) continue;
			const K = keys[s];
			if (K === skip) continue;
			let sp = 0, size = 0;
			stack[sp++] = s; comp[s] = n;
			while (sp) {
				const p = stack[--sp];
				size++;
				const x = p % W;
				let q;
				if (x > 0 && comp[q = p - 1] < 0 && keys[q] === K) { comp[q] = n; stack[sp++] = q; }
				if (x < W - 1 && comp[q = p + 1] < 0 && keys[q] === K) { comp[q] = n; stack[sp++] = q; }
				if (p >= W && comp[q = p - W] < 0 && keys[q] === K) { comp[q] = n; stack[sp++] = q; }
				if (p < N - W && comp[q = p + W] < 0 && keys[q] === K) { comp[q] = n; stack[sp++] = q; }
			}
			sizes.push(size); keyOf.push(K); first.push(s);
			n++;
		}
		return { comp, n, sizes, keyOf, first };
	}

	function csr(comp, n) {
		const start = new Int32Array(n + 1);
		for (let p = 0; p < comp.length; p++) if (comp[p] >= 0) start[comp[p] + 1]++;
		for (let i = 0; i < n; i++) start[i + 1] += start[i];
		const order = new Int32Array(start[n]), fill = start.slice(0, n);
		for (let p = 0; p < comp.length; p++) if (comp[p] >= 0) order[fill[comp[p]]++] = p;
		return { start, order };
	}

	function neighbors4(p, W, N, cb) {
		const x = p % W;
		if (x > 0) cb(p - 1);
		if (x < W - 1) cb(p + 1);
		if (p >= W) cb(p - W);
		if (p < N - W) cb(p + W);
	}

	// 多数決（3×3 でいちばん多い色に揃える）。境目のギザギザが減り、線がなめらかになる
	function modeFilter(labels, W, H, iters) {
		const cnt = new Int32Array(64), touched = [];
		for (let it = 0; it < iters; it++) {
			const out = labels.slice();
			for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
				touched.length = 0;
				for (let dy = -1; dy <= 1; dy++) {
					const yy = y + dy;
					if (yy < 0 || yy >= H) continue;
					for (let dx = -1; dx <= 1; dx++) {
						const xx = x + dx;
						if (xx < 0 || xx >= W) continue;
						const l = labels[yy * W + xx];
						if (!cnt[l]) touched.push(l);
						cnt[l]++;
					}
				}
				const own = labels[y * W + x];
				let best = own, bc = cnt[own];
				for (const l of touched) if (cnt[l] > bc) { bc = cnt[l]; best = l; }
				for (const l of touched) cnt[l] = 0;
				out[y * W + x] = best;
			}
			labels.set(out);
		}
	}

	// 小さな領域を、いちばん長く接している隣の色へ吸収する
	function mergeSmall(labels, W, H, minArea, cands) {
		if (minArea <= 1) return;
		const N = W * H, cnt = new Int32Array(64);
		for (let pass = 0; pass < 12; pass++) {
			const R = cc4(Int32Array.from(labels), W, H, -1);
			const { start, order } = csr(R.comp, R.n);
			const small = [];
			for (let c = 0; c < R.n; c++) if (R.sizes[c] < minArea) small.push(c);
			if (!small.length) break;
			small.sort((a, b) => R.sizes[a] - R.sizes[b]);
			let changed = 0;
			for (const c of small) {
				const own = labels[order[start[c]]];
				cnt.fill(0);
				let joined = false;
				for (let k = start[c]; k < start[c + 1]; k++) {
					neighbors4(order[k], W, N, q => {
						if (R.comp[q] === c) return;
						if (labels[q] === own) joined = true; else cnt[labels[q]]++;
					});
				}
				if (joined) continue;
				let best = -1, bc = 0;
				for (let l = 0; l < 64; l++) {
					if (cnt[l] > bc) { bc = cnt[l]; best = l; }
					else if (cnt[l] === bc && bc > 0 && best >= 0) {
						const o = cands[own].lab, A = cands[l].lab, B = cands[best].lab;
						const da = (o[0] - A[0]) ** 2 + (o[1] - A[1]) ** 2 + (o[2] - A[2]) ** 2;
						const db = (o[0] - B[0]) ** 2 + (o[1] - B[1]) ** 2 + (o[2] - B[2]) ** 2;
						if (da < db) best = l;
					}
				}
				if (best < 0) continue;
				for (let k = start[c]; k < start[c + 1]; k++) labels[order[k]] = best;
				changed++;
			}
			if (!changed) break;
		}
	}

	// 似た色の隣り合う領域を、K 個になるまで統合する（Ward 法: 面積×色差² の小さい順）
	function wardMerge(labels, lab, W, H, K, cands, penalty) {
		const N = W * H;
		const R = cc4(Int32Array.from(labels), W, H, -1);
		const n = R.n;
		if (typeof K === 'function') K = K(n);
		if (n <= K) return n;
		const size = new Float64Array(n), sL = new Float64Array(n), sA = new Float64Array(n), sB = new Float64Array(n);
		for (let p = 0; p < N; p++) {
			const r = R.comp[p];
			size[r]++; sL[r] += lab[p * 3]; sA[r] += lab[p * 3 + 1]; sB[r] += lab[p * 3 + 2];
		}
		const adj = Array.from({ length: n }, () => new Set());
		for (let p = 0; p < N; p++) {
			const r = R.comp[p], x = p % W;
			if (x < W - 1) { const q = R.comp[p + 1]; if (q !== r) { adj[r].add(q); adj[q].add(r); } }
			if (p < N - W) { const q = R.comp[p + W]; if (q !== r) { adj[r].add(q); adj[q].add(r); } }
		}
		const parent = new Int32Array(n).map((_, i) => i);
		const ver = new Int32Array(n), merged = new Uint8Array(n);
		const cost = (a, b) => {
			const dL = sL[a] / size[a] - sL[b] / size[b], dA = sA[a] / size[a] - sA[b] / size[b], dB = sB[a] / size[a] - sB[b] / size[b];
			return (dL * dL + dA * dA + dB * dB) * size[a] * size[b] / (size[a] + size[b]);
		};
		const heap = [];
		const push = e => {
			heap.push(e);
			let i = heap.length - 1;
			while (i > 0) { const pi = (i - 1) >> 1; if (heap[pi][0] <= heap[i][0]) break; [heap[pi], heap[i]] = [heap[i], heap[pi]]; i = pi; }
		};
		const pop = () => {
			const top = heap[0], last = heap.pop();
			if (heap.length) {
				heap[0] = last;
				let i = 0;
				for (;;) {
					const l = 2 * i + 1, r = l + 1;
					let m = i;
					if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
					if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
					if (m === i) break;
					[heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
				}
			}
			return top;
		};
		for (let a = 0; a < n; a++) for (const b of adj[a]) if (a < b) push([cost(a, b), a, b, 0, 0]);
		let alive = n;
		while (alive > K && heap.length) {
			const [, a0, b0, va, vb] = pop();
			if (parent[a0] !== a0 || parent[b0] !== b0 || ver[a0] !== va || ver[b0] !== vb) continue;
			const a = size[a0] >= size[b0] ? a0 : b0, b = a === a0 ? b0 : a0;
			parent[b] = a;
			size[a] += size[b]; sL[a] += sL[b]; sA[a] += sA[b]; sB[a] += sB[b];
			merged[a] = 1;
			for (const nb of adj[b]) { if (nb === a) continue; adj[nb].delete(b); adj[nb].add(a); adj[a].add(nb); }
			adj[a].delete(b); adj[b] = null;
			ver[a]++; alive--;
			for (const nb of adj[a]) push(a < nb ? [cost(a, nb), a, nb, ver[a], ver[nb]] : [cost(nb, a), nb, a, ver[nb], ver[a]]);
		}
		const find = r => { while (parent[r] !== r) { parent[r] = parent[parent[r]]; r = parent[r]; } return r; };
		const newLabel = new Int32Array(n).fill(-1);
		for (let p = 0; p < N; p++) {
			const r = find(R.comp[p]);
			if (!merged[r]) continue;
			if (newLabel[r] < 0) newLabel[r] = nearestCand(sL[r] / size[r], sA[r] / size[r], sB[r] / size[r], cands, penalty);
			labels[p] = newLabel[r];
		}
		return alive;
	}

	// mask のドットに、近くの mask 外のドットの色を流し込む。block のドットは通り抜けない
	function fillMasked(labels, mask, W, H, block) {
		const N = W * H, q = new Int32Array(N), done = new Uint8Array(N);
		let qh = 0, qt = 0;
		for (let p = 0; p < N; p++) if (!mask[p] && !(block && block[p])) { done[p] = 1; q[qt++] = p; }
		while (qh < qt) {
			const p = q[qh++];
			neighbors4(p, W, N, r => {
				if (done[r] || (block && block[r])) return;
				done[r] = 1; labels[r] = labels[p]; q[qt++] = r;
			});
		}
	}

	//=============================================================================
	// 主線（暗い線）の抽出
	//=============================================================================
	function maxMin(src, W, H, r, isMax) {
		const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
		const f = isMax ? Math.max : Math.min;
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			let v = src[y * W + x];
			for (let d = -r; d <= r; d++) { const xx = x + d; if (xx >= 0 && xx < W) v = f(v, src[y * W + xx]); }
			tmp[y * W + x] = v;
		}
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			let v = tmp[y * W + x];
			for (let d = -r; d <= r; d++) { const yy = y + d; if (yy >= 0 && yy < H) v = f(v, tmp[yy * W + x]); }
			out[y * W + x] = v;
		}
		return out;
	}

	// dark: 周囲より暗い細い線（ブラックハット変換）。edge: 明るさの段差（Sobel）
	function extractLines(L, W, Hw, opt) {
		const N = W * Hw, m = new Uint8Array(N);
		if (opt.method === 'edge') {
			for (let y = 1; y < Hw - 1; y++) for (let x = 1; x < W - 1; x++) {
				const p = y * W + x;
				const gx = (L[p - W + 1] + 2 * L[p + 1] + L[p + W + 1]) - (L[p - W - 1] + 2 * L[p - 1] + L[p + W - 1]);
				const gy = (L[p + W - 1] + 2 * L[p + W] + L[p + W + 1]) - (L[p - W - 1] + 2 * L[p - W] + L[p - W + 1]);
				if (Math.sqrt(gx * gx + gy * gy) / 4 > opt.threshold) m[p] = 1;
			}
		} else {
			const closed = maxMin(maxMin(L, W, Hw, opt.radius, true), W, Hw, opt.radius, false);
			for (let p = 0; p < N; p++) if (closed[p] - L[p] > opt.threshold && L[p] < opt.darkLimit) m[p] = 1;
		}
		return m;
	}

	function downMask(m, W, Hw, H) {
		if (Hw === H) return m.slice();
		const out = new Uint8Array(W * H);
		for (let y = 0; y < H; y++) {
			const y0 = Math.floor(y * Hw / H), y1 = Math.max(y0 + 1, Math.floor((y + 1) * Hw / H));
			for (let x = 0; x < W; x++) for (let yy = y0; yy < y1; yy++) if (m[yy * W + x]) { out[y * W + x] = 1; break; }
		}
		return out;
	}

	// 細線化（1 ドット幅の骨格にする）。
	//  1. Zhang-Suen 法でおおまかに細くする
	//  2. 残った余分なドット（階段の角など）を、つながり方を変えない範囲で 1 つずつ除く
	//     （横井の連結数が 1 で、隣が 2 つ以上あるドット）
	// 結果は、分岐点以外のドットがちょうど 2 つの隣を持つ 8 連結の線になる。
	// 画面の端のドットは削らない。端まで届いている線の先が 1 ドットでも削れると、
	// そこから塗りが漏れる（線は画面の端と合わせて領域を閉じている）。
	function thin(m, W, H) {
		const PW = W + 2, PH = H + 2, g = new Uint8Array(PW * PH);
		const pinned = (x, y) => x === 1 || y === 1 || x === PW - 2 || y === PH - 2;
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[(y + 1) * PW + x + 1] = m[y * W + x] ? 1 : 0;
		const del = [];
		let changed = true;
		while (changed) {
			changed = false;
			for (let step = 0; step < 2; step++) {
				del.length = 0;
				for (let y = 1; y < PH - 1; y++) for (let x = 1; x < PW - 1; x++) {
					const p = y * PW + x;
					if (!g[p] || pinned(x, y)) continue;
					const P2 = g[p - PW], P3 = g[p - PW + 1], P4 = g[p + 1], P5 = g[p + PW + 1];
					const P6 = g[p + PW], P7 = g[p + PW - 1], P8 = g[p - 1], P9 = g[p - PW - 1];
					const B = P2 + P3 + P4 + P5 + P6 + P7 + P8 + P9;
					if (B < 2 || B > 6) continue;
					const A = (!P2 && P3) + (!P3 && P4) + (!P4 && P5) + (!P5 && P6) + (!P6 && P7) + (!P7 && P8) + (!P8 && P9) + (!P9 && P2);
					if (A !== 1) continue;
					if (step === 0) { if (P2 && P4 && P6) continue; if (P4 && P6 && P8) continue; }
					else { if (P2 && P4 && P8) continue; if (P2 && P6 && P8) continue; }
					del.push(p);
				}
				for (const p of del) g[p] = 0;
				if (del.length) changed = true;
			}
		}
		changed = true;
		while (changed) {
			changed = false;
			for (let y = 1; y < PH - 1; y++) for (let x = 1; x < PW - 1; x++) {
				const p = y * PW + x;
				if (!g[p] || pinned(x, y)) continue;
				// x1=東 x2=北東 x3=北 x4=北西 x5=西 x6=南西 x7=南 x8=南東
				const n = [g[p + 1], g[p - PW + 1], g[p - PW], g[p - PW - 1], g[p - 1], g[p + PW - 1], g[p + PW], g[p + PW + 1]];
				let B = 0;
				for (let k = 0; k < 8; k++) B += n[k];
				if (B < 2) continue;
				let c8 = 0;
				for (let k = 0; k < 8; k += 2) {
					const a = 1 - n[k], b = 1 - n[k + 1], c = 1 - n[(k + 2) & 7];
					c8 += a - a * b * c;
				}
				if (c8 === 1) { g[p] = 0; changed = true; }
			}
		}
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) m[y * W + x] = g[(y + 1) * PW + x + 1];
		return m;
	}

	// 模様の除去: 線が周囲 (2r+1)² に密集している所は、網点や縞とみなして捨てる
	function suppressTexture(m, W, H, r, maxDensity) {
		const I = new Int32Array((W + 1) * (H + 1));
		for (let y = 0; y < H; y++) {
			let row = 0;
			for (let x = 0; x < W; x++) { row += m[y * W + x]; I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + row; }
		}
		const out = m.slice();
		for (let y = 0; y < H; y++) {
			const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
			for (let x = 0; x < W; x++) {
				if (!m[y * W + x]) continue;
				const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
				const s = I[y1 * (W + 1) + x1] - I[y0 * (W + 1) + x1] - I[y1 * (W + 1) + x0] + I[y0 * (W + 1) + x0];
				if (s > maxDensity * (x1 - x0) * (y1 - y0)) out[y * W + x] = 0;
			}
		}
		m.set(out);
		return m;
	}

	// 8 連結で minLen ドット未満の切れ端を捨てる
	function pruneShort(m, W, H, minLen) {
		if (minLen <= 1) return m;
		const N = W * H, seen = new Uint8Array(N), stack = new Int32Array(N), list = [];
		for (let s = 0; s < N; s++) {
			if (!m[s] || seen[s]) continue;
			let sp = 0; list.length = 0;
			stack[sp++] = s; seen[s] = 1;
			while (sp) {
				const p = stack[--sp];
				list.push(p);
				const x = p % W, y = (p / W) | 0;
				for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
					const xx = x + dx, yy = y + dy;
					if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
					const q = yy * W + xx;
					if (m[q] && !seen[q]) { seen[q] = 1; stack[sp++] = q; }
				}
			}
			if (list.length < minLen) for (const p of list) m[p] = 0;
		}
		return m;
	}

	// 隙間閉じ: 線の端から、線の向きに maxGap ドットまで延ばし、別の線か画面の端に届いたらつなぐ
	function closeGaps(m, W, H, maxGap) {
		if (maxGap <= 0) return m;
		const N = W * H;
		const inb = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
		const nb8 = (p, cb) => {
			const x = p % W, y = (p / W) | 0;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && inb(x + dx, y + dy)) cb((y + dy) * W + x + dx);
		};
		const ends = [];
		for (let p = 0; p < N; p++) {
			if (!m[p]) continue;
			let d = 0;
			nb8(p, q => { if (m[q]) d++; });
			if (d === 1) ends.push(p);
		}
		const add = [];
		for (const e of ends) {
			const own = new Set([e]);
			let cur = e;
			for (let k = 0; k < 6; k++) {
				let next = -1;
				nb8(cur, q => { if (next < 0 && m[q] && !own.has(q)) next = q; });
				if (next < 0) break;
				own.add(next); cur = next;
			}
			if (cur === e) continue;
			const ex = e % W, ey = (e / W) | 0;
			let vx = ex - cur % W, vy = ey - ((cur / W) | 0);
			const len = Math.hypot(vx, vy);
			vx /= len; vy /= len;
			const path = [];
			let hit = false;
			LP3.linePixels(ex, ey, Math.round(ex + vx * maxGap), Math.round(ey + vy * maxGap), (x, y) => {
				if (hit) return;
				if (!inb(x, y)) { if (path.length) hit = true; return; }
				const p = y * W + x;
				if (p === e) return;
				path.push(p);
				const touches = q => m[q] && !own.has(q) && !path.includes(q);
				if (m[p] && !own.has(p)) { hit = true; return; }
				if ((x > 0 && touches(p - 1)) || (x < W - 1 && touches(p + 1)) || (y > 0 && touches(p - W)) || (y < H - 1 && touches(p + W))) hit = true;
			});
			if (hit) add.push(...path);
		}
		for (const p of add) m[p] = 1;
		return m;
	}

	function dilate(m, W, H) {
		const out = m.slice();
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			if (!m[y * W + x]) continue;
			for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				const xx = x + dx, yy = y + dy;
				if (xx >= 0 && yy >= 0 && xx < W && yy < H) out[yy * W + xx] = 1;
			}
		}
		return out;
	}

	//=============================================================================
	// 線の網
	//=============================================================================
	const DX8 = [1, 1, 0, -1, -1, -1, 0, 1], DY8 = [0, -1, -1, -1, 0, 1, 1, 1];
	const TYPE_PSEUDO = 1, TYPE_MAIN = 2;

	// 線にするドットを決める。
	//  ・主線のドット
	//  ・主線でないドットのうち、右か下の（主線でない）ドットと色が違うもの（色の境目）
	// 上下左右に隣り合う「色の違う 2 ドット」は、必ずどちらかが線になる。
	// つまりこの線は、4 連結の塗りつぶしを必ず止める。
	function lineSeedMask(labels, main, W, H) {
		const N = W * H, type = new Uint8Array(N);
		for (let p = 0; p < N; p++) {
			if (main && main[p]) { type[p] = TYPE_MAIN; continue; }
			const x = p % W;
			if (x < W - 1 && !(main && main[p + 1]) && labels[p + 1] !== labels[p]) type[p] = TYPE_PSEUDO;
			else if (p < N - W && !(main && main[p + W]) && labels[p + W] !== labels[p]) type[p] = TYPE_PSEUDO;
		}
		return type;
	}

	// 骨格（1 ドット幅の線）を、分岐点・端点から次の分岐点・端点までの「鎖」に分ける。
	// 鎖は両端の分岐点のドットを含む（同じ分岐点に集まる鎖は、そのドットを共有する）。
	function traceChains(m, W, H) {
		const N = W * H;
		const at = (x, y) => x >= 0 && y >= 0 && x < W && y < H && m[y * W + x];
		const deg = new Uint8Array(N);
		for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
			if (!m[y * W + x]) continue;
			let d = 0;
			for (let k = 0; k < 8; k++) if (at(x + DX8[k], y + DY8[k])) d++;
			deg[y * W + x] = d;
		}
		const isNode = p => m[p] && deg[p] !== 2;
		const used = new Uint8Array(N);
		const edgeUsed = new Set();
		const chains = [];
		const walk = (s, n) => {
			const path = [s, n];
			used[n] = 1;
			let prev = s, cur = n;
			for (;;) {
				const cx = cur % W, cy = (cur / W) | 0;
				let next = -1;
				for (let k = 0; k < 8; k++) {
					const xx = cx + DX8[k], yy = cy + DY8[k];
					if (!at(xx, yy)) continue;
					const q = yy * W + xx;
					if (q === prev) continue;
					if (isNode(q) || !used[q]) { next = q; break; }
				}
				if (next < 0) break;
				path.push(next);
				if (isNode(next)) break;
				if (next === s) break; // 輪
				used[next] = 1;
				prev = cur; cur = next;
			}
			return path;
		};
		for (let s = 0; s < N; s++) {
			if (!isNode(s)) continue;
			if (deg[s] === 0) { chains.push([s]); continue; }
			const sx = s % W, sy = (s / W) | 0;
			for (let k = 0; k < 8; k++) {
				const xx = sx + DX8[k], yy = sy + DY8[k];
				if (!at(xx, yy)) continue;
				const n = yy * W + xx;
				if (isNode(n)) {
					const key = s < n ? s * N + n : n * N + s;
					if (edgeUsed.has(key)) continue;
					edgeUsed.add(key);
					chains.push([s, n]);
				} else if (!used[n]) {
					chains.push(walk(s, n));
				}
			}
		}
		// 分岐点も端点もない輪
		for (let s = 0; s < N; s++) {
			if (!m[s] || used[s] || deg[s] !== 2) continue;
			used[s] = 1;
			const sx = s % W, sy = (s / W) | 0;
			for (let k = 0; k < 8; k++) {
				const xx = sx + DX8[k], yy = sy + DY8[k];
				if (!at(xx, yy)) continue;
				const n = yy * W + xx;
				if (used[n]) continue;
				const path = walk(s, n);
				if (path[path.length - 1] !== s) path.push(s);
				chains.push(path);
				break;
			}
		}
		return { chains, deg };
	}

	function bresenhamMatches(xs, ys, i, k) {
		const x1 = xs[i], y1 = ys[i], x2 = xs[k], y2 = ys[k];
		if (Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1)) + 1 !== k - i + 1) return false;
		const rev = y1 > y2 || (y1 === y2 && x1 > x2);
		let t = rev ? k : i, ok = true;
		LP3.linePixels(x1, y1, x2, y2, (x, y) => {
			if (ok && (xs[t] !== x || ys[t] !== y)) ok = false;
			t += rev ? -1 : 1;
		});
		return ok;
	}

	// Douglas-Peucker 法（いちばん外れた点を頂点に残して二分していく）。縦は aspect 倍の距離で測る
	function simplifyDP(xs, ys, eps, aspect) {
		const n = xs.length, keep = new Uint8Array(n);
		keep[0] = keep[n - 1] = 1;
		const stack = [[0, n - 1]];
		while (stack.length) {
			const [a, b] = stack.pop();
			if (b - a < 2) continue;
			const dx = xs[b] - xs[a], dy = (ys[b] - ys[a]) * aspect, len = Math.hypot(dx, dy);
			let far = -1, fd = eps;
			for (let i = a + 1; i < b; i++) {
				const ex = xs[i] - xs[a], ey = (ys[i] - ys[a]) * aspect;
				const d = len === 0 ? Math.hypot(ex, ey) : Math.abs(dy * ex - dx * ey) / len;
				if (d > fd) { fd = d; far = i; }
			}
			if (far >= 0) { keep[far] = 1; stack.push([a, far], [far, b]); }
		}
		const v = [];
		for (let i = 0; i < n; i++) if (keep[i]) v.push(xs[i], ys[i]);
		return v;
	}

	// 許容誤差 eps に収まる限り、できるだけ遠くまで 1 本の線分で引く（頂点がいちばん少なくなる向きの貪欲法）。
	// eps は線分からのずれ（ドット。縦は aspect 倍で測る）
	function simplifyGreedy(xs, ys, eps, aspect) {
		const n = xs.length, v = [xs[0], ys[0]];
		const within = (i, k) => {
			const ax = xs[i], ay = ys[i] * aspect, dx = xs[k] - ax, dy = ys[k] * aspect - ay, len = Math.hypot(dx, dy);
			for (let j = i + 1; j < k; j++) {
				const ex = xs[j] - ax, ey = ys[j] * aspect - ay;
				let d;
				if (len === 0) d = Math.hypot(ex, ey);
				else {
					// 線分の外側に飛び出す点は、端点からの距離で測る（折り返しをまたいで 1 本にしない）
					const t = (ex * dx + ey * dy) / (len * len);
					d = t < 0 ? Math.hypot(ex, ey) : t > 1 ? Math.hypot(ex - dx, ey - dy) : Math.abs(dy * ex - dx * ey) / len;
				}
				if (d > eps) return false;
			}
			return true;
		};
		let i = 0;
		while (i < n - 1) {
			let best = i + 1, miss = 0;
			for (let k = i + 2; k < n && k - i <= 400; k++) {
				// ドットどおりに引ける区間は、許容誤差に関係なく認める
				if (within(i, k) || bresenhamMatches(xs, ys, i, k)) { best = k; miss = 0; }
				else if (++miss > 8) break;
			}
			v.push(xs[best], ys[best]);
			i = best;
		}
		return v;
	}

	// ドットをぴったり再現する折れ線（eps = 0 のとき）
	function simplifyExact(xs, ys) {
		const n = xs.length, v = [xs[0], ys[0]];
		let i = 0;
		while (i < n - 1) {
			let best = i + 1, miss = 0;
			for (let k = i + 2; k < n && k - i <= 400; k++) {
				if (bresenhamMatches(xs, ys, i, k)) { best = k; miss = 0; }
				else if (++miss > 6) break;
			}
			v.push(xs[best], ys[best]);
			i = best;
		}
		return v;
	}

	// 任意のドットの集まりを、ぴったり再現する折れ線にする（仕上げの修正用）。
	// 端（隣が 1 つ以下）のドットから、残っているドットを 1 本の道としてたどり、線分にまとめる。
	// 進む向きは「直前と同じ向き」を優先する（長い線分にまとまりやすい）。
	function coverDots(mask, W, H) {
		const N = W * H, rem = mask.slice(), polys = [];
		const deg = p => {
			const x = p % W, y = (p / W) | 0;
			let d = 0;
			for (let k = 0; k < 8; k++) { const xx = x + DX8[k], yy = y + DY8[k]; if (xx >= 0 && yy >= 0 && xx < W && yy < H && rem[yy * W + xx]) d++; }
			return d;
		};
		const ORDER = [0, 2, 4, 6, 1, 3, 5, 7]; // 上下左右を先に、斜めを後に
		const trace = s => {
			const xs = [s % W], ys = [(s / W) | 0];
			rem[s] = 0;
			let last = -1;
			for (;;) {
				const x = xs[xs.length - 1], y = ys[ys.length - 1];
				let next = -1, nd = -1;
				const tryDir = d => {
					const xx = x + DX8[d], yy = y + DY8[d];
					if (xx < 0 || yy < 0 || xx >= W || yy >= H || !rem[yy * W + xx]) return false;
					next = yy * W + xx; nd = d;
					return true;
				};
				if (!(last >= 0 && tryDir(last))) for (let i = 0; i < 8 && next < 0; i++) tryDir(ORDER[i]);
				if (next < 0) break;
				rem[next] = 0;
				xs.push(next % W); ys.push((next / W) | 0);
				last = nd;
			}
			polys.push(xs.length === 1 ? [xs[0], ys[0], xs[0], ys[0]] : simplifyExact(xs, ys));
		};
		for (let s = 0; s < N; s++) if (rem[s] && deg(s) <= 1) trace(s);
		for (let s = 0; s < N; s++) if (rem[s]) trace(s);
		return polys;
	}

	//=============================================================================
	// 全体の流れ
	//=============================================================================
	// opt: {
	//   width, height, aspect, fit, paletteKey, colors, clearColor(-1 自動), bgColor(-1 自動),
	//   deDither, smoothIters, sigmaR, penalty, minArea, edgeSmooth,
	//   useLines, lineMethod, lineRadius, lineThreshold, lineDark, lineMinLen, lineTexture, lineGap, lineColor(-1 自動),
	//   strokeEps, toneLevels, paintOrder('each'|'staged'), bgLast, pack, drawMode('normal'|'palette'), palColors（palette の見せ色 [描いている色, それ以外の色]）,
	//   goalIdeal（「減色のみ」の絵を完成形にする）,
	//   adjust: { r, g, b, sat, bright, contrast }（原画の色補正。-100〜100）,
	//   budgetKB(0 で上限なし), coarse(0〜1)
	// }

	// 粗さ s（0〜1）に連動する設定。
	//  0〜0.7 : 線も領域も残したまま、ストロークの頂点を間引いて形を多角形にしていく
	//  0.7〜1 : それでも足りないときの最後の手段。飾りの線を捨て、似た色の領域をまとめる
	C.SHAPE_PHASE = 0.7;
	//
	// 「減色のみ」の絵を完成形にするとき（goalIdeal）は別の配分にする。
	//  線を間引くと、崩れた分を最後に点で直すことになり、かえってデータが増える。
	//  そこで線はドットどおりに引き、粗さは「減色のみの絵そのものを単純にする」方向だけに使う
	//  （境目をならす、小さな領域を吸収する、似た色の領域をまとめる、短い主線を捨てる）。
	C.coarseParams = function (s, opt) {
		if (opt.goalIdeal && (opt.colors || []).length !== 1) {
			return {
				eps: 0,
				modeIters: opt.edgeSmooth + Math.round(3 * s),
				minArea: Math.round(opt.minArea * (1 + 6 * s)),
				lineMinLen: opt.lineMinLen + Math.round(60 * s * s),
				mergeT: s,
				dropDecor: 0,
			};
		}
		const t1 = Math.min(1, s / C.SHAPE_PHASE);
		const t2 = Math.max(0, (s - C.SHAPE_PHASE) / (1 - C.SHAPE_PHASE));
		return {
			eps: opt.strokeEps + 8 * Math.pow(t1, 1.2) + 6 * t2,
			modeIters: opt.edgeSmooth + Math.round(2 * t1),
			minArea: Math.round(opt.minArea * (1 + 2 * t1 + 4 * t2)),
			lineMinLen: opt.lineMinLen + Math.round(4 * t1 + 40 * t2),
			mergeT: t2,
			dropDecor: 0.9 * t2,
		};
	};

	// 縮小して色補正をかけた原画（線形 RGB）。縮小は覚えておいて使い回す
	function resampledAdjusted(img, opt) {
		const W = opt.width, H = opt.height;
		const rkey = [W, H, opt.aspect, opt.fit, !!opt.deDither].join();
		if (!C._rs || C._rs.img !== img || C._rs.key !== rkey) C._rs = { img, key: rkey, rs: C.resample(img, W, H, opt.aspect, opt.fit, opt.deDither) };
		return { lin: C.adjustColors(C._rs.rs.lin, opt.adjust), W, Hw: C._rs.rs.Hw };
	}

	// 下書き: 線や領域の処理を省き、色の割り当てだけをすぐに返す（色補正のスライダーを動かしている間の表示用）。
	// 平滑化は 1 回だけにしているので、正式な変換結果より少しざらつく。
	// 戻り値: { buf（色番号）, source（補正後の原画の canvas を作る関数）, width, height, pixelAspect, palette }
	// sourceOnly を真にすると、色の割り当てを省く（補正後の原画だけ欲しいとき）
	C.draft = function (img, opt, sourceOnly) {
		const W = opt.width, H = opt.height, N = W * H;
		const pal = LP3.PALETTES[opt.paletteKey];
		const sel = (opt.colors && opt.colors.length ? opt.colors : [0, 1, 2, 3, 4, 5, 6, 7]).slice().sort((a, b) => a - b);
		const rs = resampledAdjusted(img, opt);
		const source = () => linToCanvas(rs.lin, W, rs.Hw);
		if (sel.length === 1 || sourceOnly) return { buf: null, source, width: W, height: H, pixelAspect: opt.aspect, palette: pal.colors };
		const cands = C.buildCandidates(pal.colors.map(LP3.hexToInt), sel);
		let lab = targetLab(rs.lin, W, rs.Hw, H);
		if (opt.smoothIters > 0) lab = bilateral(lab, W, H, opt.aspect, 1, opt.sigmaR);
		if (sel.length < 8) lab = remapLightness(lab, N, cands);
		const buf = new Uint8Array(N);
		for (let p = 0; p < N; p++) {
			const c = cands[nearestCand(lab[p * 3], lab[p * 3 + 1], lab[p * 3 + 2], cands, opt.penalty)];
			buf[p] = ((p % W + ((p / W) | 0)) & 1) ? c.b : c.a;
		}
		return { buf, source, width: W, height: H, pixelAspect: opt.aspect, palette: pal.colors };
	};

	// 粗さに関係しない下ごしらえ（容量の探索中に使い回す）
	C.prepare = function (img, opt) {
		const W = opt.width, H = opt.height, aspect = opt.aspect, N = W * H;
		const pal = LP3.PALETTES[opt.paletteKey];
		const palInts = pal.colors.map(LP3.hexToInt);
		const sel = (opt.colors && opt.colors.length ? opt.colors : [0, 1, 2, 3, 4, 5, 6, 7]).slice().sort((a, b) => a - b);
		const cands = C.buildCandidates(palInts, sel);
		const allL = C.buildCandidates(palInts).L;
		const sketch = sel.length === 1;

		// 縮小は手間がかかるので、同じ画像・同じ設定なら前回の結果を使い回す
		// （色補正のスライダーを動かすたびに縮小からやり直さないため）
		const rs = resampledAdjusted(img, opt);
		let lab = targetLab(rs.lin, W, rs.Hw, H);
		if (opt.smoothIters > 0) lab = bilateral(lab, W, H, aspect, opt.smoothIters, opt.sigmaR);
		if (sel.length < 8 && !sketch) lab = remapLightness(lab, N, cands);

		// 紙の色の指定（使う色に入っているものだけ有効）
		const wantClear = !sketch && sel.includes(opt.clearColor) ? opt.clearColor : -1;
		// 主線の色: 指定が使う色に入っていなければ、使う色でいちばん暗い色。
		// 紙の色を指定されていて、それとぶつかるなら、紙といちばん明るさの違う色にする
		// （紙を黒にすれば、白い線で描く絵になる）
		let lineColor = opt.lineColor;
		if (sketch) lineColor = sel[0];
		else {
			if (lineColor < 0 || !sel.includes(lineColor)) {
				lineColor = sel[0];
				for (const c of sel) if (cands.L[c] < cands.L[lineColor]) lineColor = c;
			}
			if (lineColor === wantClear) {
				let bd = -1;
				for (const c of sel) {
					const d = Math.abs(cands.L[c] - cands.L[wantClear]);
					if (c !== wantClear && d > bd) { bd = d; lineColor = c; }
				}
			}
		}
		// 紙の色（最初に画面を塗る色）
		let clear;
		if (sketch) {
			// 線画の背景: 指定がなければ、線の色といちばん明るさが違う色
			clear = opt.bgColor;
			if (clear < 0 || clear === lineColor) {
				let bd = -1;
				for (let i = 0; i < 8; i++) {
					if (i === lineColor) continue;
					const d = Math.abs(allL[i] - allL[lineColor]);
					if (d > bd) { bd = d; clear = i; }
				}
			}
		} else {
			// 指定がなければ、使う色でいちばん明るい色（元の絵と同じく、白い紙に描く感じ）
			clear = wantClear;
			if (clear < 0 || clear === lineColor) {
				clear = -1;
				for (const c of sel) if (c !== lineColor && (clear < 0 || cands.L[c] > cands.L[clear])) clear = c;
			}
		}

		let rawMask = null;
		if (opt.useLines || sketch) {
			const Lw = workLuminance(rs.lin, W, rs.Hw);
			const mw = extractLines(Lw, W, rs.Hw, { method: opt.lineMethod, radius: opt.lineRadius, threshold: opt.lineThreshold, darkLimit: opt.lineDark });
			rawMask = downMask(mw, W, rs.Hw, H);
			// 画面のいちばん外側の 1 ドットは主線の候補から外す。端の行・列は、網点を均す処理や暗い線の検出で
			// 「周り」が片側しかなく、誤って線と判定されやすい（細線化は端のドットを削らないので、端いっぱいの線になる）。
			// 主線が端の 1 ドット手前で止まっても、色の境目の線が端まで補うので、領域は閉じる
			for (let x = 0; x < W; x++) { rawMask[x] = 0; rawMask[(H - 1) * W + x] = 0; }
			for (let y = 0; y < H; y++) { rawMask[y * W] = 0; rawMask[y * W + W - 1] = 0; }
			thin(rawMask, W, H);
			if (opt.lineTexture !== false) suppressTexture(rawMask, W, H, 4, 0.3);
		}
		let baseLabels, labelCands = cands;
		if (sketch) {
			if (opt.toneLevels > 1) { const t = toneLabels(lab, N, opt.toneLevels); baseLabels = t.labels; labelCands = t.cands; }
			else { baseLabels = new Uint8Array(N); labelCands = [{ a: 0, b: 0, solid: true, lab: new Float32Array(3) }]; labelCands.sel = [0]; labelCands.wC = 0; }
		} else {
			baseLabels = new Uint8Array(N);
			for (let p = 0; p < N; p++) baseLabels[p] = nearestCand(lab[p * 3], lab[p * 3 + 1], lab[p * 3 + 2], cands, opt.penalty);
		}
		return { W, H, aspect, pal, cands, labelCands, sel, sketch, lab, lineColor, clear, rawMask, baseLabels, resampled: linToCanvas(rs.lin, W, rs.Hw) };
	};

	const byteLength = s => new TextEncoder().encode(s).length;

	// 粗さ s で絵データを組み立てる
	C.build = function (prep, opt, s) {
		const { W, H, aspect, cands, labelCands, sketch, lab, lineColor, clear } = prep;
		const N = W * H;
		const cp = C.coarseParams(s, opt);
		const Lof = cands.L;

		//--- 主線 -------------------------------------------------------------
		// 隙間をつないで細くしてから、短い切れ端を捨てる（V2 と同じ順番）
		let main = null;
		if (prep.rawMask) {
			main = prep.rawMask.slice();
			if (opt.lineGap > 0) { closeGaps(main, W, H, opt.lineGap); thin(main, W, H); }
			pruneShort(main, W, H, cp.lineMinLen);
		}

		//--- 色の地図 ---------------------------------------------------------
		const labels = prep.baseLabels.slice();
		if (main) {
			// 主線とそのすぐ脇は、線のにじみで暗い色になっている。両側の色で埋め直す
			// （主線は通り抜けないので、線の向こう側の色が染み出すことはない）
			fillMasked(labels, dilate(main, W, H), W, H, main);
			fillMasked(labels, main, W, H, null);
		}
		if (cp.modeIters > 0) modeFilter(labels, W, H, cp.modeIters);
		mergeSmall(labels, W, H, sketch ? Math.max(cp.minArea, 24) : cp.minArea, labelCands);
		if (cp.mergeT > 0) {
			const t = cp.mergeT;
			wardMerge(labels, lab, W, H, n => Math.max(Math.min(n, 3), Math.round(Math.pow(n, 1 - t) * Math.pow(Math.min(n, 3), t))), labelCands, sketch ? 0 : opt.penalty);
			mergeSmall(labels, W, H, cp.minArea, labelCands);
		}

		//--- 線の網 → 鎖 -----------------------------------------------------
		const type = lineSeedMask(labels, main, W, H);
		const skel = new Uint8Array(N);
		for (let p = 0; p < N; p++) skel[p] = type[p] ? 1 : 0;
		thin(skel, W, H);
		const { chains: rawChains, deg } = traceChains(skel, W, H);

		// 鎖ごとに、種類（主線か色の境目か）と、両側の色を調べる
		const onBorder = p => { const x = p % W, y = (p / W) | 0; return x === 0 || y === 0 || x === W - 1 || y === H - 1; };
		const chains = [];
		const cnt = new Map();
		for (const path of rawChains) {
			let nMain = 0;
			cnt.clear();
			for (const p of path) {
				if (type[p] === TYPE_MAIN) nMain++;
				const x = p % W, y = (p / W) | 0;
				for (let k = 0; k < 8; k++) {
					const xx = x + DX8[k], yy = y + DY8[k];
					if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
					const q = yy * W + xx;
					if (skel[q]) continue;
					cnt.set(labels[q], (cnt.get(labels[q]) || 0) + 1);
				}
			}
			const sides = [...cnt.entries()].sort((a, b) => b[1] - a[1]);
			const A = sides.length ? sides[0][0] : labels[path[0]];
			// 2 番目の色は、ある程度の長さで接しているものだけ（角で少し触れるだけの色は数えない）
			const B = sides.length > 1 && sides[1][1] >= Math.max(1, Math.floor(path.length * 0.2)) ? sides[1][0] : A;
			let under = 0;
			for (const p of path) if (labels[p] === A) under++;
			const isMain = nMain * 2 >= path.length;
			const a0 = path[0], a1 = path[path.length - 1];
			const free0 = deg[a0] <= 1 && !onBorder(a0), free1 = deg[a1] <= 1 && !onBorder(a1);
			chains.push({ path, isMain, A, B, underA: under, dangling: free0 || free1, closed: a0 === a1 && path.length > 2 });
		}

		//--- 線の色 -----------------------------------------------------------
		// pen: 最初に引く色。fin: 最終的な色。pen ≠ fin の線は、最後に引き直す。
		// 守ること: pen は紙の色 clear にしない（塗りが線で止まらなくなるため）。
		const darker = c => {
			const d = Lof[c.a] <= Lof[c.b] ? c.a : c.b;
			return d !== clear ? d : (d === c.a ? c.b : c.a);
		};
		let decorTotal = 0;
		for (const ch of chains) {
			// 細線化で残ったひげ（片端が宙に浮いた短い鎖）は引かない
			if (ch.dangling && ch.path.length < (ch.isMain ? 4 : 6)) { ch.keep = false; continue; }
			if (sketch) { ch.pen = ch.fin = lineColor; ch.keep = true; continue; }
			if (ch.isMain) {
				ch.pen = ch.fin = lineColor; ch.keep = true;
				ch.decor = ch.A === ch.B; // 両側が同じ色 = 領域を分けていない飾りの線
				if (ch.decor) decorTotal += ch.path.length;
				continue;
			}
			// 色の境目。両側が同じ色なら、境目ではない（細線化の残りなど）ので引かない
			if (ch.A === ch.B) { ch.keep = false; continue; }
			ch.keep = true;
			const ca = cands[ch.A], cb = cands[ch.B];
			let pick, redrawOK = false, others;
			if (ca.solid && cb.solid) {
				// どちらに溶け込ませても境目が 1 ドット動くだけ。線が多く乗っている側の色に
				pick = ch.underA * 2 >= ch.path.length ? ca.a : cb.a;
				others = [pick === ca.a ? cb.a : ca.a];
			} else if (ca.solid || cb.solid) {
				// 単色の側に溶け込ませる（完全に見えなくなる）
				const so = ca.solid ? ca : cb, ck = ca.solid ? cb : ca;
				pick = so.a; redrawOK = true;
				others = [darker(ck), ck.a, ck.b];
			} else {
				// 両方市松: 共通の色があればそれ、なければ線が乗っている側の暗い方
				const shared = [ca.a, ca.b].find(c => c === cb.a || c === cb.b);
				pick = shared !== undefined ? shared : darker(ch.underA * 2 >= ch.path.length ? ca : cb);
				others = [darker(ca), darker(cb), ca.a, ca.b, cb.a, cb.b];
			}
			if (pick !== clear) { ch.pen = ch.fin = pick; continue; }
			// 溶け込ませたい色が紙の色だった。別の色で引いておく
			const alt = others.find(c => c !== clear);
			ch.pen = alt !== undefined ? alt : lineColor;
			// 単色の紙の色に溶け込ませる線は、最後に紙の色で引き直せば完全に消える
			ch.fin = redrawOK ? clear : ch.pen;
		}

		// 最後の手段: 飾りの線（領域を分けていない主線）を短い順に捨てる
		if (cp.dropDecor > 0 && decorTotal > 0) {
			const decor = chains.filter(ch => ch.keep && ch.decor).sort((a, b) => a.path.length - b.path.length);
			let dropped = 0;
			for (const ch of decor) {
				if (dropped >= decorTotal * cp.dropDecor) break;
				ch.keep = false; dropped += ch.path.length;
			}
		}

		// 調査用: 鎖がどう扱われたか（1 主線 2 色の境目 3 両側同色で省略 4 ひげで省略 5 飾りで省略）
		const dbg = new Uint8Array(N);
		for (const ch of chains) {
			const code = ch.keep ? (ch.isMain ? 1 : 2) : (ch.dangling && ch.path.length < (ch.isMain ? 4 : 6)) ? 4 : ch.decor ? 5 : 3;
			for (const q of ch.path) if (!dbg[q] || code < dbg[q]) dbg[q] = code;
		}

		//--- 頂点の間引き → ストロークの順番 → 描き戻し -----------------------
		// 鎖の両端（分岐点）は動かさないので、間引いても線どうしのつながりは保たれる
		// 0.5 ドット未満の許容誤差は、ドットどおりと同じ
		// 間引き方の使い分け:
		//  ・0.5 未満 … ドットどおり
		//  ・1.5 未満 … 「できるだけ遠くまで引く」方式と Douglas-Peucker 法の、頂点の少ない方
		//  ・それ以上 … Douglas-Peucker 法。いちばん外れた点（＝角）を頂点に残すので、粗くしても形が崩れにくい。
		//               「遠くまで引く」方式は角を斜めに切り落としがちで、線の間に細かい隙間の領域が増える
		const simplify = (xs, ys) => {
			if (cp.eps < 0.5) return simplifyExact(xs, ys);
			const b = simplifyDP(xs, ys, cp.eps, aspect);
			if (cp.eps >= 1.5) return b;
			const a = simplifyGreedy(xs, ys, cp.eps, aspect);
			return a.length <= b.length ? a : b;
		};
		const strokes = [];
		for (const ch of chains) {
			if (!ch.keep) continue;
			const xs = ch.path.map(p => p % W), ys = ch.path.map(p => (p / W) | 0);
			let v;
			if (xs.length === 1) v = [xs[0], ys[0], xs[0], ys[0]];
			else if (ch.closed && cp.eps > 0) {
				// 輪は、始点からいちばん遠い点で二つに分けて間引く
				let far = 1, fd = -1;
				for (let i = 1; i < xs.length - 1; i++) { const d = Math.hypot(xs[i] - xs[0], (ys[i] - ys[0]) * aspect); if (d > fd) { fd = d; far = i; } }
				const a = simplify(xs.slice(0, far + 1), ys.slice(0, far + 1));
				const b = simplify(xs.slice(far), ys.slice(far));
				v = a.concat(b.slice(2));
			}
			else v = simplify(xs, ys);
			strokes.push({ v, pen: ch.pen, fin: ch.fin, isMain: ch.isMain, len: ch.path.length });
		}

		// 色ごとにまとめる（主線の色が最初。あとは長さの合計が多い順）
		const groups = new Map();
		for (const st of strokes) {
			if (!groups.has(st.pen)) groups.set(st.pen, { color: st.pen, list: [], total: 0 });
			const g = groups.get(st.pen);
			g.list.push(st); g.total += st.len;
		}
		const groupOrder = [...groups.values()].sort((a, b) => (a.color === lineColor ? -1 : b.color === lineColor ? 1 : b.total - a.total));
		const penPolys = [];   // [{color, polys}]
		const finPolys = new Map();
		for (const g of groupOrder) {
			const polys = orderStrokes(g.list, aspect);
			penPolys.push({ color: g.color, polys: polys.map(o => o.v) });
			for (const o of polys) {
				for (const part of o.parts) {
					if (part.fin === part.pen) continue;
					if (!finPolys.has(part.fin)) finPolys.set(part.fin, []);
					finPolys.get(part.fin).push(part.v);
				}
			}
		}

		// 描き戻し: エンジンと同じ線分で描いて、線のドットを確定する
		const pen = new Int8Array(N).fill(-1);
		const draw = (buf, polys, color) => {
			for (const v of polys) {
				if (v.length === 2) { buf[v[1] * W + v[0]] = color; continue; }
				for (let i = 0; i + 3 < v.length; i += 2) LP3.linePixels(v[i], v[i + 1], v[i + 2], v[i + 3], (x, y) => { if (x >= 0 && y >= 0 && x < W && y < H) buf[y * W + x] = color; });
			}
		};
		for (const g of penPolys) draw(pen, g.polys, g.color);
		const fin = pen.slice();
		for (const [color, polys] of finPolys) draw(fin, polys, color);

		//--- 命令列 -----------------------------------------------------------
		const ops = [];
		const pushLines = (color, polys) => { if (polys.length) ops.push(['L', color, ...polys]); };
		ops.push(['S', 1]);
		for (const g of penPolys) pushLines(g.color, g.polys);

		const T = new Uint8Array(N).fill(clear);
		let regionCount = 0, flatCount = 0, tileCount = 0;
		if (!sketch) {
			// 線で閉じた範囲 = 線でないドットの 4 連結成分。色は、その範囲のドットの多数決
			const keys = new Int32Array(N);
			for (let p = 0; p < N; p++) keys[p] = pen[p] >= 0 ? -1 : 0;
			const R = cc4(keys, W, H, -1);
			const { start, order } = csr(R.comp, R.n);
			regionCount = R.n;
			const regs = [];
			const votes = new Int32Array(64);
			let bgIdx = -1, bgBorder = -1;
			for (let r = 0; r < R.n; r++) {
				votes.fill(0);
				let sx = 0, sy = 0, border = 0;
				const rejSet = new Set();
				for (let k = start[r]; k < start[r + 1]; k++) {
					const p = order[k], x = p % W, y = (p / W) | 0;
					votes[labels[p]]++;
					sx += x; sy += y;
					if (x === 0 || y === 0 || x === W - 1 || y === H - 1) border++;
					neighbors4(p, W, N, q => { if (pen[q] >= 0) rejSet.add(pen[q]); });
				}
				let label = 0;
				for (let l = 1; l < 64; l++) if (votes[l] > votes[label]) label = l;
				const size = start[r + 1] - start[r];
				// 種点: 重心にいちばん近いドット（そこから上下へ広がって塗られる）
				const gx = sx / size, gy = sy / size;
				let seed = order[start[r]], sd = Infinity;
				for (let k = start[r]; k < start[r + 1]; k++) {
					const p = order[k], d = (p % W - gx) ** 2 + ((((p / W) | 0) - gy) * aspect) ** 2;
					if (d < sd) { sd = d; seed = p; }
				}
				const c = cands[label];
				for (let k = start[r]; k < start[r + 1]; k++) {
					const p = order[k];
					T[p] = ((p % W + ((p / W) | 0)) & 1) ? c.b : c.a;
				}
				const rej = [...rejSet].sort((a, b) => a - b);
				const reg = { size, seed, c, rej, flat: -1, tile: !c.solid };
				if (c.solid) {
					if (c.a !== clear) reg.flat = c.a; // 紙の色の領域は、何もしなくても完成している
				} else if (c.a !== clear && c.b !== clear) {
					// ベタの色: タイルの 2 色のうち、周りの線の色でない方（明るい方を優先）。
					// どちらも線の色なら、ベタを省いて直接タイルで塗る
					const pref = Lof[c.a] >= Lof[c.b] ? [c.a, c.b] : [c.b, c.a];
					const base = pref.find(x => !rejSet.has(x));
					if (base !== undefined) reg.flat = base;
				}
				if (border > bgBorder) { bgBorder = border; bgIdx = regs.length; }
				regs.push(reg);
			}
			// 塗る順番: 大きい領域から。背景（画面の端にいちばん長く接する領域）は最後
			const bg = opt.bgLast !== false && bgIdx >= 0 ? regs[bgIdx] : null;
			const sorted = regs.filter(r => r !== bg).sort((a, b) => b.size - a.size);
			if (bg) sorted.push(bg);
			const xy = p => [p % W, (p / W) | 0];
			let curStage = 1, lastKey = '';
			const pushPaint = (stage, pat, rej, seed) => {
				const key = stage + JSON.stringify(pat) + JSON.stringify(rej);
				const last = ops[ops.length - 1];
				// 直前と同じ工程・模様・除外色なら、種点を足すだけにする
				if (key === lastKey && last[0] === 'P') { last[3].push(...xy(seed)); return; }
				if (stage !== curStage) { ops.push(['S', stage]); curStage = stage; }
				ops.push(['P', pat, rej, xy(seed)]);
				lastKey = key;
			};
			const flatOf = reg => { flatCount++; pushPaint(2, [[reg.flat]], reg.rej, reg.seed); };
			const tileOf = reg => { tileCount++; pushPaint(3, [[reg.c.a, reg.c.b], [reg.c.b, reg.c.a]], reg.rej, reg.seed); };
			if (opt.paintOrder === 'staged') {
				for (const reg of sorted) if (reg.flat >= 0) flatOf(reg);
				for (const reg of sorted) if (reg.tile) tileOf(reg);
			} else {
				for (const reg of sorted) {
					if (reg.flat >= 0) flatOf(reg);
					if (reg.tile) tileOf(reg);
				}
			}
		}
		for (let p = 0; p < N; p++) if (fin[p] >= 0) T[p] = fin[p];

		let redrawSegs = 0;
		if (finPolys.size) {
			ops.push(['S', 4]);
			for (const [color, polys] of finPolys) { pushLines(color, polys); for (const v of polys) redrawSegs += v.length / 2 - 1; }
		}

		// 理想の絵（線の間引きや縁のずれがない、減色しただけの絵）。忠実さの目安に使う
		const ideal = new Uint8Array(N);
		if (sketch) { ideal.set(T); }
		else {
			for (let p = 0; p < N; p++) { const c = cands[labels[p]]; ideal[p] = ((p % W + ((p / W) | 0)) & 1) ? c.b : c.a; }
			if (main) for (let p = 0; p < N; p++) if (main[p]) ideal[p] = lineColor;
		}

		// 「減色のみ」の絵を完成形にする: ここまでの工程で描いた絵と減色のみの絵が違うドットを、
		// 最後（工程 4）に点と線を打って直す。線を引いて塗る運びは変えず、仕上げだけ揃える。
		let fixDots = 0, fixSegs = 0;
		if (opt.goalIdeal && !sketch) {
			const byColor = [];
			for (let p = 0; p < N; p++) {
				if (T[p] === ideal[p]) continue;
				(byColor[ideal[p]] || (byColor[ideal[p]] = new Uint8Array(N)))[p] = 1;
				fixDots++;
			}
			if (fixDots) {
				if (!finPolys.size) ops.push(['S', 4]);
				for (let c = 0; c < 8; c++) {
					if (!byColor[c]) continue;
					const polys = coverDots(byColor[c], W, H);
					pushLines(c, polys);
					for (const v of polys) fixSegs += Math.max(1, v.length / 2 - 1);
				}
				T.set(ideal);
			}
		}

		const pic = {
			format: 'line_painter', version: 3,
			width: W, height: H, pixelAspect: aspect,
			paletteName: opt.paletteKey, palette: prep.pal.colors.slice(),
			colors: prep.sel.slice(), clear, ops,
		};
		if (opt.drawMode === 'palette') {
			pic.drawMode = 'palette';
			pic.palColors = (opt.palColors || LP3.PAL_DEFAULT).map(c => '#' + LP3.hexToInt(c).toString(16).padStart(6, '0'));
		}
		const text = C.serialize(pic, opt.pack !== false);
		let segs = 0, polyCount = 0;
		for (const g of penPolys) for (const v of g.polys) { polyCount++; segs += Math.max(1, v.length / 2 - 1); }
		return {
			pic, text, bytes: byteLength(text), target: T, ideal, s,
			lineView: { pen, fin, dbg, labels },
			counts: { strokes: polyCount, segments: segs, regions: regionCount, flats: flatCount, tiles: tileCount, redrawSegs, fixDots, fixSegs },
		};
	};

	// ストロークの順番を決める。ペンが近い所から近い所へ動くように並べ、
	// 端がつながるストロークは 1 本の折れ線にまとめる（なるべくまっすぐ続く方を選ぶ）
	function orderStrokes(list, aspect) {
		const n = list.length, used = new Uint8Array(n), out = [];
		const ends = list.map(st => { const v = st.v; return [v[0], v[1], v[v.length - 2], v[v.length - 1]]; });
		let cx = 0, cy = 0, dirx = 0, diry = 0, cur = null;
		for (let done = 0; done < n; done++) {
			let best = -1, bestRev = false, bc = Infinity;
			for (let i = 0; i < n; i++) {
				if (used[i]) continue;
				const e = ends[i];
				for (let rev = 0; rev < 2; rev++) {
					const sx = rev ? e[2] : e[0], sy = rev ? e[3] : e[1];
					let cost = Math.hypot(sx - cx, (sy - cy) * aspect) * 10;
					if (cur && cost <= 15) {
						// つながる候補どうしでは、曲がりの小さい方を選ぶ
						const v = list[i].v, k = rev ? v.length - 4 : 2;
						const nx = v[k] - sx, ny = (v[k + 1] - sy) * aspect, nl = Math.hypot(nx, ny) || 1;
						cost += 1 - (nx * dirx + ny * diry) / nl;
					} else if (!cur) cost += sy * 0.01; // 最初は上の方から
					if (cost < bc) { bc = cost; best = i; bestRev = !!rev; }
				}
			}
			used[best] = 1;
			const st = list[best];
			let v = st.v;
			if (bestRev) { v = []; for (let i = st.v.length - 2; i >= 0; i -= 2) v.push(st.v[i], st.v[i + 1]); }
			const part = { v, pen: st.pen, fin: st.fin };
			const joinable = cur && Math.max(Math.abs(v[0] - cx), Math.abs(v[1] - cy)) <= 1;
			if (joinable) {
				const same = v[0] === cx && v[1] === cy;
				cur.v.push(...(same ? v.slice(2) : v));
				cur.parts.push(part);
			} else {
				cur = { v: v.slice(), parts: [part] };
				out.push(cur);
			}
			const m = cur.v.length;
			cx = cur.v[m - 2]; cy = cur.v[m - 1];
			const px = m >= 4 ? cur.v[m - 4] : cx, py = m >= 4 ? cur.v[m - 3] : cy;
			const dl = Math.hypot(cx - px, (cy - py) * aspect) || 1;
			dirx = (cx - px) / dl; diry = (cy - py) * aspect / dl;
		}
		return out;
	}

	//=============================================================================
	// 検証・探索・保存
	//=============================================================================
	// エンジンで実際に描かせて、目標の絵とドット単位で比べる
	C.verify = function (pic, T) {
		const buf = new LP3.Engine(pic).runAll();
		let bad = 0;
		for (let p = 0; p < T.length; p++) if (buf[p] !== T[p]) bad++;
		return { bad, buf };
	};

	C.run = function (img, opt) {
		const t0 = performance.now();
		const prep = C.prepare(img, opt);
		const budget = opt.budgetKB > 0 ? opt.budgetKB * 1024 : 0;
		let best, tries = 0, budgetOk = true;
		if (!budget) { best = C.build(prep, opt, opt.coarse || 0); tries = 1; }
		else {
			// 容量に収まる中で、いちばん細かい粗さを探す。粗さと容量は必ずしも比例しないので、
			// まず 9 段階で一通り測り、収まった最初の段とその手前の間を二分探索で詰める
			const r0 = C.build(prep, opt, 0); tries++;
			if (r0.bytes <= budget) best = r0;
			else {
				let prev = 0, smallest = r0, found = null;
				for (let k = 1; k <= 8; k++) {
					const r = C.build(prep, opt, k / 8); tries++;
					if (r.bytes < smallest.bytes) smallest = r;
					if (r.bytes <= budget) { found = r; break; }
					prev = k / 8;
				}
				if (!found) { best = smallest; budgetOk = false; }
				else {
					let lo = prev, hi = found.s;
					for (let i = 0; i < 4; i++) {
						const mid = (lo + hi) / 2;
						const r = C.build(prep, opt, mid); tries++;
						if (r.bytes <= budget) { hi = mid; found = r; } else lo = mid;
					}
					best = found;
				}
			}
		}
		// 保存する文字列そのものを読み直して描かせ、目標の絵と一致するか確かめる
		const v = C.verify(LP3.parsePicture(best.text), best.target);
		let diff = 0;
		for (let p = 0; p < best.target.length; p++) if (best.target[p] !== best.ideal[p]) diff++;
		return {
			picture: best.pic, text: best.text, target: best.target, ideal: best.ideal,
			lineView: best.lineView, resampled: prep.resampled,
			stats: {
				...best.counts, bytes: best.bytes, mismatch: v.bad,
				idealDiff: diff / best.target.length,
				seconds: LP3.Engine.duration(best.pic),
				clear: prep.clear, lineColor: prep.lineColor, colors: prep.sel.slice(), sketch: prep.sketch,
				coarse: best.s, budgetKB: opt.budgetKB || 0, budgetOk, tries,
				ms: Math.round(performance.now() - t0),
			},
		};
	};

	// pack: 折れ線（"D"）と塗りの並び（"R"）を圧縮する。切ると、読める形（"L" "P" "S"）で出す
	C.serialize = function (pic, pack) {
		const head = {
			format: pic.format, version: pic.version,
			width: pic.width, height: pic.height, pixelAspect: pic.pixelAspect,
			paletteName: pic.paletteName, palette: pic.palette, colors: pic.colors, clear: pic.clear,
		};
		if (pic.drawMode) head.drawMode = pic.drawMode;
		if (pic.drawMode && pic.palColors) head.palColors = pic.palColors;
		let s = JSON.stringify(head, null, '\t');
		s = s.slice(0, s.lastIndexOf('}')).replace(/\s*$/, '');
		const out = [];
		if (!pack) for (const op of pic.ops) out.push(JSON.stringify(op));
		else {
			// 工程 2・3 の塗りを 1 つの "R" にまとめる。同じ種点・同じ除外色の「ベタ → タイル」は 1 件にする
			let recs = null;
			const flush = () => { if (recs && recs.length) out.push(JSON.stringify(['R', LP3.packPaints(recs)])); recs = null; };
			const kindOf = pat => {
				if (pat.length === 1 && pat[0].length === 1) return 'flat';
				if (pat.length === 2 && pat[0].length === 2 && pat[0][0] === pat[1][1] && pat[0][1] === pat[1][0]) return 'tile';
				return '';
			};
			for (const op of pic.ops) {
				const k = op[0];
				if (k === 'S' && (op[1] === 2 || op[1] === 3)) continue; // "R" が工程の印を兼ねる
				if (k === 'P' && kindOf(op[1])) {
					const tile = kindOf(op[1]) === 'tile', pat = op[1], rej = op[2], sd = op[3];
					if (!recs) recs = [];
					for (let i = 0; i + 1 < sd.length; i += 2) {
						const last = recs[recs.length - 1];
						if (tile && last && last.flat >= 0 && last.a < 0 && last.x === sd[i] && last.y === sd[i + 1] && last.rej.join() === rej.join()) {
							last.a = pat[0][0]; last.b = pat[0][1];
						} else recs.push({ flat: tile ? -1 : pat[0][0], a: tile ? pat[0][0] : -1, b: tile ? pat[0][1] : -1, rej, x: sd[i], y: sd[i + 1] });
					}
					continue;
				}
				flush();
				if (k === 'L') {
					const plain = JSON.stringify(op), packed = JSON.stringify(['D', op[1], LP3.packPolys(op.slice(2))]);
					out.push(packed.length < plain.length ? packed : plain);
				} else out.push(JSON.stringify(op));
			}
			flush();
		}
		s += ',\n\t"ops": [\n' + out.map(op => '\t\t' + op).join(',\n') + '\n\t]\n}';
		return '// ラインペイント絵データ V3（lp_player_v3.html 用）\nwindow.LP_PICTURE = ' + s + ';\n';
	};
})(typeof window !== 'undefined' ? window : globalThis);
