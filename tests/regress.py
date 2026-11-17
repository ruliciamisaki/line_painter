"""ラインペイント変換 の回帰テスト。

Chromium 上で lp_converter.html を実際に動かし、設定の組み合わせを流して次を確かめる
（1 つでも外れれば終了コード 1）。
  - ページでエラーが出ない
  - 検証のずれが 0（保存する文字列を読み直してエンジンで描いた結果が、完成の絵と一致）
  - 命令が描く色が、使う色（線画は背景色も）に収まる。紙の色で線を引いていない
  - 容量指定に届いたと報告したとき、実際の容量が上限以下
  - 「減色のみの絵」との差が上限以内（塗りの漏れなど、大きな崩れの検出）。
    「減色のみ」を完成形にする設定では、差が厳密に 0
  - まとめ式（同じ色番号をまとめて塗る）で、従来式と完成の絵が同じで、色番号の切り替えが減っている
  - GIF アニメの最後のコマが完成の絵と同じで、長さが「描画時間 + 2 秒」（Pillow があるときだけ）
  - デジタルパレットの描画モードで、通常モードと最終の画面が同じ。描いている間は選んだ 2 つの見せ色しか見せず、
    最後に全部黒で待ってから既定のパレットに戻る

使い方:
  pip install playwright
  python -m playwright install chromium
  python tests/regress.py
  python tests/regress.py --illust 別の画像.png   （'illust' のケースを別のイラストで流す）
結果の画像は tests/out/ に保存される。
"""
import asyncio
import json
import pathlib
import sys

from playwright.async_api import async_playwright

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
IMG = HERE / 'images'
# 'illust' と書いたケースで使うイラスト。--illust で別の画像に差し替えられる
ILLUST = ROOT / 'docs' / 'images' / 'sample1_source.png'
for i, a in enumerate(sys.argv[1:]):
    if a == '--illust' and i + 2 < len(sys.argv):
        ILLUST = pathlib.Path(sys.argv[i + 2]).resolve()
OUT = HERE / 'out'

ALL = [0, 1, 2, 3, 4, 5, 6, 7]
# (名前, 画像, 解像度, パレット, 使う色, 追加の設定(JS), 容量KB(0=なし), 減色のみとの差の上限)
CASES = [
    ('8色 既定',            'illust',       '640x200x2', 'digital8', ALL, '', 0, 0.03),
    ('8色 主線なし',        'illust',       '640x200x2', 'digital8', ALL, "$('useLines').checked=false", 0, 0.04),
    ('8色 単純化0',         'illust',       '640x200x2', 'digital8', ALL, "$('eps').value='0'", 0, 0.02),
    ('8色 ベタ全部→タイル', 'illust',       '640x200x2', 'digital8', ALL, "$('order').value='staged'", 0, 0.03),
    ('8色 圧縮なし',        'illust',       '640x200x2', 'digital8', ALL, "$('pack').checked=false", 0, 0.03),
    ('160x144',             'illust',       '160x144x1', 'digital8', ALL, '', 0, 0.06),
    ('任意 写真',           'photo.png', 'custom',    'digital8', ALL, '', 0, 0.06),
    ('写真 段差の線',       'photo.png', '640x200x2', 'db8',      ALL, "$('lmethod').value='edge'", 0, 0.10),
    ('5色',                 'illust',       '640x200x2', 'digital8', [0, 2, 4, 6, 7], '', 0, 0.03),
    ('DB8 4色',             'illust',       '640x200x2', 'db8',      [0, 3, 6, 7], '', 0, 0.04),
    ('2色 白黒',            'illust',       '640x200x2', 'digital8', [0, 7], '', 0, 0.04),
    ('2色 赤青',            'illust',       '640x200x2', 'digital8', [1, 2], '', 0, 0.06),
    ('紙の色を黒に',        'illust',       '640x200x2', 'digital8', ALL, "CLEAR=0", 0, 0.04),
    ('1色 線画',            'illust',       '640x200x2', 'digital8', [0], '', 0, 1),
    ('1色 線画 写真',       'photo.png', '640x200x2', 'digital8', [7], '', 0, 1),
    ('容量 12KB',           'illust',      '640x200x2', 'digital8', ALL, '', 12, 0.10),
    ('容量 8KB',            'illust',      '640x200x2', 'digital8', ALL, '', 8, 0.10),
    ('容量 6KB',            'illust',      '640x200x2', 'digital8', ALL, '', 6, 0.12),
    ('容量 1KB（届かない）', 'illust',      '640x200x2', 'digital8', ALL, '', 1, 1),
    ('容量 8KB 線画',       'illust',      '640x200x2', 'db8',      [1], '', 8, 1),
    ('容量 3KB 160x144',    'illust',      '160x144x1', 'digital8', ALL, '', 3, 0.15),
    # デジタルパレットの描画モード（できあがる絵は通常と同じ）
    ('パレットモード',      'illust',      '640x200x2', 'digital8', ALL, "$('drawMode').value='palette'", 0, 0.03),
    ('パレット ベタ全部→',  'illust',      '640x200x2', 'digital8', ALL, "$('drawMode').value='palette'; $('order').value='staged'", 0, 0.03),
    ('パレット 圧縮なし',   'illust',      '640x200x2', 'db8',      ALL, "$('drawMode').value='palette'; $('pack').checked=false", 0, 0.04),
    ('パレット 白と赤',     'illust',      '640x200x2', 'digital8', ALL, "$('drawMode').value='palette'; palColors=['#ffffff','#ff0000']; refreshPalPick()", 0, 0.03),
    ('パレット DB8 緑と青', 'illust',      '640x200x2', 'db8',      ALL, "$('drawMode').value='palette'; palColors=['#00ff00','#0000ff']; refreshPalPick()", 0, 0.04),
    ('パレット 線画',       'illust',      '640x200x2', 'digital8', [7], "$('drawMode').value='palette'", 0, 1),
    # まとめ式（同じ色番号をまとめて塗る）。色番号の切り替えが 20 回以下になること
    ('まとめ式',            'illust',      '640x200x2', 'digital8', ALL, "$('paintGroup').value='color'; $('drawMode').value='palette'", 0, 0.03),
    ('まとめ式 ベタ全部→',  'illust',      '640x200x2', 'digital8', ALL, "$('paintGroup').value='color'; $('order').value='staged'", 0, 0.03),
    ('まとめ式 写真 DB8',   'photo.png',   '640x200x2', 'db8',      ALL, "$('paintGroup').value='color'; $('drawMode').value='palette'", 0, 0.06),
    ('まとめ式 減色のみ',   'illust',      '640x200x2', 'digital8', ALL, "$('paintGroup').value='color'; $('goalIdeal').checked=true", 0, 0),
    # 「減色のみ」の絵を完成形にする（差は厳密に 0 でなければならない）
    ('減色のみを完成形',    'illust',      '640x200x2', 'digital8', ALL, "$('goalIdeal').checked=true", 0, 0),
    ('減色のみ 主線なし',   'illust',      '640x200x2', 'digital8', ALL, "$('goalIdeal').checked=true; $('useLines').checked=false", 0, 0),
    ('減色のみ 2色',        'illust',      '640x200x2', 'digital8', [0, 7], "$('goalIdeal').checked=true", 0, 0),
    ('減色のみ 写真',       'photo.png',   '640x200x2', 'db8',      ALL, "$('goalIdeal').checked=true", 0, 0),
    ('減色のみ 20KB',       'illust',      '640x200x2', 'digital8', ALL, "$('goalIdeal').checked=true", 20, 0),
    ('減色のみ パレット',   'illust',      '640x200x2', 'digital8', ALL, "$('goalIdeal').checked=true; $('drawMode').value='palette'", 0, 0),
    # 原画の色補正
    ('補正 彩度+60 明+30',  'illust',      '640x200x2', 'digital8', ALL, "$('aSat').value=60; $('aBright').value=30", 0, 0.03),
    ('補正 彩度-100',       'illust',      '640x200x2', 'digital8', ALL, "$('aSat').value=-100", 0, 0.04),
    ('補正 赤-100 対比+50', 'photo.png',   '640x200x2', 'digital8', ALL, "$('aR').value=-100; $('aCont').value=50", 0, 0.06),
]

# 既定値に戻す（前のケースの設定を持ち越さない）
RESET_JS = """(() => {
  $('useLines').checked = true; $('eps').value = '0.7'; $('order').value = 'each'; $('pack').checked = true;
  $('lmethod').value = 'dark'; $('bgLast').checked = true; $('coarse').value = '0';
  $('drawMode').value = 'normal'; $('goalIdeal').checked = false; $('paintGroup').value = 'size';
  palColors = LP3.PAL_DEFAULT.slice(); refreshPalPick();
  document.querySelectorAll('input.adj').forEach(e => { e.value = 0; });
})()"""

# デジタルパレットの描画モードの確認:
#   d     … 通常モードと最終の画面（色番号）が違うドット数（0 のはず）
#   bad   … 描いている間に、2 つの見せ色以外の色を見せた／「描いている色」を 2 つ以上の色番号に割り当てた回数（0 のはず）
#   cols  … 画面で選んだ見せ色が絵データに入り、エンジンがそれを使っているか
#   fin   … 描き終えたら既定のパレットに戻っているか
#   blank … 絵を現す直前に、全部黒で待つ状態があったか
PALETTE_JS = """(() => {
  const a = new LP3.Engine(result.picture, 'normal').runAll();
  const e = new LP3.Engine(result.picture, 'palette'); e.start();
  let bad = 0, blank = false; const actives = new Set();
  while (e.advance(20, 1)) {
    const p = e.displayPalette(); let blue = 0;
    for (const c of p) { if (c === e.palDraw) blue++; else if (c !== e.palHide) bad++; }
    if (blue > 1) bad++;
    if (blue === 0 && e.stage === 0 && actives.size) blank = true;
    actives.add(e.active);
  }
  let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== e.buf[i]) d++;
  const want = (typeof palColors !== 'undefined' ? palColors : LP3.PAL_DEFAULT).map(LP3.hexToInt);
  const cols = want[0] === e.palDraw && want[1] === e.palHide;
  return { d, bad, blank, cols, fin: e.displayPalette().join() === e.palette.join(), mode: result.picture.drawMode || '', actives: [...actives].filter(c => c >= 0).length };
})()"""

USED_JS = """(() => {
  const pen = new Set(), paint = new Set();
  for (const op of result.picture.ops) {
    if (op[0] === 'L' || op[0] === 'D') pen.add(op[1]);
    else if (op[0] === 'P') op[1].flat().forEach(c => paint.add(c));
  }
  return { pen: [...pen], paint: [...paint], stages: result.picture.ops.filter(o => o[0] === 'S').map(o => o[1]) };
})()"""


# まとめ式の確認: 同じ設定を従来式で変換して、完成の絵（色番号）が同じかと、従来式の切り替え回数を返す
GROUP_JS = """(() => {
  const a = new LP3.Engine(result.picture, 'normal').runAll();
  const r = LP3.convert.run(srcImg, Object.assign(options(), { paintGroup: 'size' }));
  const b = new LP3.Engine(r.picture, 'normal').runAll();
  let same = a.length === b.length; for (let i = 0; same && i < a.length; i++) if (a[i] !== b[i]) same = false;
  return { same, switches: r.stats.switches };
})()"""

# GIF アニメの確認（Pillow があるときだけ）:
#   最後のコマが描き切った絵と同じか、全体の長さが「描画時間 + 2 秒」になっているか
try:
    from PIL import Image
except ImportError:
    Image = None

GIF_JS = """(async () => {
  const bytes = await LP3.makeGif(result.picture, { speed: 1, fps: 20, zoom: 1 });
  let bin = ''; for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode(...bytes.subarray(i, i + 32768));
  const e = new LP3.Engine(result.picture); e.runAll();
  const c = document.createElement('canvas'); e.blit(c);
  return [btoa(bin), c.toDataURL()];
})()"""


async def check_gif(page, seconds):
    import base64, io
    g64, ref = await page.evaluate(GIF_JS)
    gif = Image.open(io.BytesIO(base64.b64decode(g64)))
    total = 0
    for k in range(gif.n_frames):
        gif.seek(k)
        total += gif.info.get('duration', 0)
    last = gif.convert('RGB')
    want = Image.open(io.BytesIO(base64.b64decode(ref.split(',')[1]))).convert('RGB').resize(last.size, Image.NEAREST)
    if last.tobytes() != want.tobytes():
        return '最後のコマが完成の絵と違う'
    if abs(total / 1000 - (seconds + 2)) > 0.15:
        return f'長さが合わない {total / 1000:.2f} 秒（描画 {seconds:.2f} 秒 + 2 秒のはず）'
    return ''


async def main():
    OUT.mkdir(exist_ok=True)
    failures = []
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={'width': 1500, 'height': 1300})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        await page.goto((ROOT / 'lp_converter.html').as_uri())
        # 開いた直後の欄の初期値（空文字だと 0 = 黒と読まれてしまう）
        init = await page.evaluate("[$('clearColor').value, $('lcolor').value]")
        if init != ['-1', '-1']:
            failures.append(f'紙の色・主線の色の初期値が自動になっていない: {init}')

        print(f"{'名前':<20} {'容量':>8} {'粗さ':>5} {'線分':>5} {'領域':>4} {'ベタ/タイル':>10} {'引直':>4} {'ずれ':>4} {'差':>6} {'秒':>5} {'変換':>7}")
        for i, (name, img, res, pal, cols, extra, kb, max_diff) in enumerate(CASES):
            await page.evaluate(RESET_JS)
            await page.select_option('#pal', pal)
            await page.evaluate(f"selColors = {json.dumps(cols)}; refreshColors();")
            clear = -1
            if extra.startswith('CLEAR='):
                clear = int(extra.split('=')[1]); extra = ''
            await page.evaluate(f"$('clearColor').value = '{clear}'")
            if extra:
                await page.evaluate(extra)
            await page.evaluate(f"$('budgetOn').checked = {str(kb > 0).lower()}; $('budget').value = '{kb or 10}'")
            await page.select_option('#res', res)
            await page.evaluate("$('status').textContent = ''")
            await page.set_input_files('#file', str(ILLUST if img == 'illust' else IMG / img))
            await page.wait_for_function(
                "(s => s.startsWith('変換 ') || s.startsWith('エラー'))(document.getElementById('status').textContent)",
                timeout=180000)
            status = await page.evaluate("$('status').textContent")
            if status.startswith('エラー'):
                failures.append(f'{name}: {status}')
                print(f'{name:<20} {status}')
                continue
            s = await page.evaluate('result.stats')
            u = await page.evaluate(USED_JS)

            allowed = set(cols) | ({s['clear']} if s['sketch'] else set())
            used = set(u['pen']) | set(u['paint']) | {s['clear']}
            if s['mismatch'] != 0:
                failures.append(f"{name}: 検証のずれ {s['mismatch']} ドット")
            if not used <= allowed:
                failures.append(f"{name}: 使わない色を描いた {sorted(used - allowed)}")
            if s['clear'] in u['pen'] and 4 not in u['stages']:
                failures.append(f"{name}: 紙の色で線を引いている")
            if kb and s['budgetOk'] and s['bytes'] > kb * 1024:
                failures.append(f"{name}: 容量超過 {s['bytes']} > {kb * 1024}")
            if s['idealDiff'] > max_diff:
                failures.append(f"{name}: 減色のみとの差が大きい {s['idealDiff'] * 100:.2f}% > {max_diff * 100:.0f}%")
            if "paintGroup" in extra:
                # 従来式で変換し直して、完成の絵が同じで、切り替えが減っていることを確かめる
                g = await page.evaluate(GROUP_JS)
                if not g['same'] or s['switches'] > 20 or s['switches'] >= g['switches']:
                    failures.append(f"{name}: まとめ式の確認に失敗 切り替え {s['switches']} 回（従来式 {g['switches']} 回）、絵が同じ={g['same']}")
            if 'palette' in extra:
                pm = await page.evaluate(PALETTE_JS)
                if pm['mode'] != 'palette' or pm['d'] or pm['bad'] or not pm['fin'] or not pm['blank'] or not pm['cols']:
                    failures.append(f"{name}: パレットモードの確認に失敗 {pm}")
            elif await page.evaluate("result.picture.drawMode !== undefined"):
                failures.append(f"{name}: 通常モードなのに drawMode が入っている")

            note = '' if s['budgetOk'] else ' (上限に届かず)'
            print(f"{name:<20} {s['bytes'] / 1024:>6.1f}KB {s['coarse']:>5.2f} {s['segments']:>5} {s['regions']:>4} "
                  f"{str(s['flats']) + '/' + str(s['tiles']):>10} {s['redrawSegs']:>4} {s['mismatch']:>4} "
                  f"{s['idealDiff'] * 100:>5.1f}% {s['seconds']:>5.1f} {s['ms']:>5}ms{note}")

            if Image is not None:
                msg = await check_gif(page, s['seconds'])
                if msg:
                    failures.append(f'{name}: GIF アニメ {msg}')

            await page.click('#bEnd')
            await page.wait_for_timeout(150)
            await page.locator('#cv').screenshot(path=str(OUT / f'{i:02d}.png'))

        await browser.close()
    if errors:
        failures.append('ページのエラー: ' + ' / '.join(errors))
    print()
    if failures:
        print('失敗:')
        for f in failures:
            print('  ' + f)
        sys.exit(1)
    print(f'すべて合格（{len(CASES)} 件）')


asyncio.run(main())
