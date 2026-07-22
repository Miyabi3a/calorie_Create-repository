const STORAGE_KEY = 'calorieChatData';

function loadData() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) return JSON.parse(raw);
  return { sex: null, age: null, heightCm: null, weightKg: null, targetWeightKg: null, activityLevel: 'light', days: {} };
}

const ACTIVITY_LEVELS = {
  sedentary: { label: '座りがち(ほとんど運動しない)', factor: 1.2 },
  light: { label: '軽い運動(週1〜3回)', factor: 1.375 },
  moderate: { label: 'ふつうの運動(週3〜5回)', factor: 1.55 },
  active: { label: '活発(週6〜7回)', factor: 1.725 },
  veryActive: { label: '非常に活発(肉体労働・激しい運動)', factor: 1.9 },
};

function saveData(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todayKey() {
  return dateKey(new Date());
}

function getDay(data, key) {
  if (!data.days[key]) data.days[key] = { logs: [] };
  return data.days[key];
}

function hasProfile(data) {
  return !!(data.sex && data.age && data.heightCm && data.weightKg);
}

// Mifflin-St Jeor式でBMRを求め、選択した活動レベルの係数でTDEEを推定。
// 体重1kgの増減に約7,700kcalの過不足が必要という目安で、1年で目標体重に到達する分を日割りして加算する。
function computeGoalKcal(data) {
  if (!hasProfile(data)) return 2000;
  const { sex, age, heightCm, weightKg, targetWeightKg } = data;
  const bmr = sex === 'male'
    ? 10 * weightKg + 6.25 * heightCm - 5 * age + 5
    : 10 * weightKg + 6.25 * heightCm - 5 * age - 161;
  const activity = ACTIVITY_LEVELS[data.activityLevel] || ACTIVITY_LEVELS.light;
  const tdee = bmr * activity.factor;
  if (!targetWeightKg) return Math.round(tdee / 10) * 10;
  const dailyAdjust = ((targetWeightKg - weightKg) * 7700) / 365;
  const goal = Math.max(1200, tdee + dailyAdjust);
  return Math.round(goal / 10) * 10;
}

// PFC比率 P30%・F20%・C50%(3:2:5)を採用し、目標カロリーから理想のグラム数を逆算する。
function computeIdealPFC(goalKcal) {
  return {
    proteinG: Math.round((goalKcal * 0.30) / 4),
    fatG: Math.round((goalKcal * 0.20) / 9),
    carbsG: Math.round((goalKcal * 0.50) / 4),
  };
}

// 五十音の行ごとの長音(ー)を正規の母音に展開するための対応表。
// 例: 「と」の後の「ー」は「う」相当(とう)、「ひ」の後の「ー」は「い」相当(ひい)とみなす。
const VOWEL_ROWS = {
  'あかさたなはまやらわがざだばぱ': 'あ',
  'いきしちにひみりゐぎじぢびぴ': 'い',
  'うくすつぬふむゆるぐずづぶぷ': 'う',
  'えけせてねへめれゑげぜでべぺ': 'い',
  'おこそとのほもよろをごぞどぼぽ': 'う',
};
const VOWEL_MAP = {};
for (const chars in VOWEL_ROWS) {
  for (const ch of chars) VOWEL_MAP[ch] = VOWEL_ROWS[chars];
}

// 「とーふ」→「とうふ」のように、ーを直前の文字の行に応じた母音に置き換える(1文字→1文字なので文字位置はズレない)。
function expandChoonpu(str) {
  let out = '';
  for (const ch of str) {
    if (ch === 'ー' && VOWEL_MAP[out[out.length - 1]]) {
      out += VOWEL_MAP[out[out.length - 1]];
    } else {
      out += ch;
    }
  }
  return out;
}

// カタカナ→ひらがな、全角英数字→半角、長音(ー)の母音展開を行い正規化する。
// 「とうふ」⇔「トウフ」⇔「とーふ」のような表記ゆれをDBに登録しなくても吸収できるようにするため。
function normalize(str) {
  const hiragana = str.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
  const halfWidth = hiragana.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  return expandChoonpu(halfWidth).toLowerCase();
}

function levenshtein(a, b) {
  const dp = [];
  for (let i = 0; i <= a.length; i++) dp.push([i, ...new Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[a.length][b.length];
}

function buildDictionary() {
  const list = [];
  // 候補チップ選択時はentry.name(スペース等を含む正式名称)がそのまま入力欄に入るため、
  // aliasesだけでなくname自体も登録しないと、送信時に正式名称が別の短いaliasに分割一致してしまう。
  FOODS.forEach((f) => {
    list.push({ type: 'food', entry: f, alias: f.name, normAlias: normalize(f.name) });
    f.aliases.forEach((a) => list.push({ type: 'food', entry: f, alias: a, normAlias: normalize(a) }));
  });
  EXERCISES.forEach((e) => {
    list.push({ type: 'exercise', entry: e, alias: e.name, normAlias: normalize(e.name) });
    e.aliases.forEach((a) => list.push({ type: 'exercise', entry: e, alias: a, normAlias: normalize(a) }));
  });
  list.sort((a, b) => b.alias.length - a.alias.length);
  return list;
}
const DICTIONARY = buildDictionary();

// 入力中のテキストの末尾から、辞書のaliasに部分一致する最長の候補群を探す。
// 「韓国風」のようにキーワードがalias/nameの先頭でなく途中にあるケースも拾えるよう、
// 前方一致ではなく部分一致(includes)で判定する(送信確定時のparseMessageも同様に部分一致のため)。
// normalize()は文字数を変えない1:1変換なので、正規化後の末尾N文字はraw文字列の末尾N文字と対応する
// (呼び出し側はこの性質を使って、rawText.length - suffixLenで置き換え開始位置を求められる)。
function computeLiveSuggestions(rawText, maxResults = 6) {
  const norm = normalize(rawText);
  if (!norm) return { suffixLen: 0, matches: [] };
  const maxSuffixLen = Math.min(norm.length, 12);
  for (let len = maxSuffixLen; len >= 1; len--) {
    const suffix = norm.slice(norm.length - len);
    const seen = new Set();
    const matches = [];
    for (const dictEntry of DICTIONARY) {
      if (!dictEntry.normAlias.includes(suffix)) continue;
      if (seen.has(dictEntry.entry.name)) continue;
      seen.add(dictEntry.entry.name);
      matches.push(dictEntry);
      if (matches.length >= maxResults * 3) break;
    }
    if (matches.length > 0) {
      matches.sort((a, b) => a.normAlias.length - b.normAlias.length);
      return { suffixLen: len, matches: matches.slice(0, maxResults) };
    }
  }
  return { suffixLen: 0, matches: [] };
}

const FOOD_COUNTER_RE = /(\d+(?:\.\d+)?)\s*(杯|個|枚|本|切れ|皿|人前|つ|缶|パック|袋|丁|貫|合|片|g|グラム|ml|cc)/;
const FOOD_FRACTION_RE = /(\d+)\s*\/\s*(\d+)\s*(杯|個|枚|本|切れ|皿|人前|つ|缶|パック|袋|丁|貫|合|片)?/;
const FOOD_HALF_RE = /半(分|人前)?/;
const EXERCISE_COUNTER_RE = /(\d+(?:\.\d+)?)\s*(分|時間|min|h)/;
const WEIGHT_RE = /(\d+(?:\.\d+)?)\s*(?:kg|キロ|㎏)/i;
const REPS_RE = /(\d+)\s*回/;
const SETS_RE = /(?:(\d+)\s*セット)|(?:[×xX*]\s*(\d+)(?!kg|キロ|㎏|回))/;
// 「1万5000歩」のような万単位混じりの表記と、「5000歩」「5,000歩」のような素の表記の両方を拾う。
const STEPS_RE = /(\d+(?:\.\d+)?)万(\d{1,4}(?:,\d{3})*)?歩|(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*歩/;
// 平均的な歩行ケイデンス(1分あたりの歩数)の目安。厳密な実測値ではなく概算用。
const STEPS_PER_MINUTE = 105;
// 歩数からカロリーを算出する対象にする運動(通常のウォーキングか、それより速い/違う歩行系か)。
const STEPS_WALK_ENTRY_NAMES = ['ウォーキング', '早歩き', '犬の散歩'];

// 重量・回数・セット数からの消費カロリー概算。
// セット×(回数×3秒動作+セット間90秒休憩)を運動時間とみなし、
// 体重に対する挙上重量の比率が高いほど強度が上がるとみなして係数を掛ける。
function computeStrengthKcal(e, bodyweightKg, weightKg, reps, sets) {
  const totalSeconds = sets * (reps * 3) + (sets - 1) * 90;
  const minutes = totalSeconds / 60;
  const ratio = weightKg / bodyweightKg;
  const intensityFactor = Math.min(2.5, Math.max(0.8, 0.8 + ratio * 0.6));
  return Math.round(e.met * bodyweightKg * (minutes / 60) * 1.05 * intensityFactor);
}

// beforeとafterの近傍を探し、マッチした場合は絶対位置(matchStart/matchEnd)も一緒に返す。
// 呼び出し側はこの範囲をマスクすることで、同じ数量トークンが別の品目に二重に使われるのを防ぐ。
// limitを指定すると、after側の探索がその位置(=次の品目の開始位置)を越えて
// 別の品目の数量表現を誤って拾わないようにできる。
function findQuantity(text, start, end, re, limit) {
  const beforeStart = Math.max(0, start - 8);
  const before = text.slice(beforeStart, start);
  const afterEnd = limit != null ? Math.min(end + 8, limit) : end + 8;
  const after = text.slice(end, afterEnd);
  let m = before.match(re);
  if (m) return { match: m, matchStart: beforeStart + m.index, matchEnd: beforeStart + m.index + m[0].length };
  m = after.match(re);
  if (m) return { match: m, matchStart: end + m.index, matchEnd: end + m.index + m[0].length };
  return null;
}

// working中で、fromIdx以降に現れる次の品目(食品・運動どちらも)の開始位置を探す。
// 見つからなければworking.lengthを返す(=制限なし)。
function findNextMatchIdx(normWorking, fromIdx) {
  let next = normWorking.length;
  for (const dictEntry of DICTIONARY) {
    const idx = normWorking.indexOf(dictEntry.normAlias, fromIdx);
    if (idx !== -1 && idx < next) next = idx;
  }
  return next;
}

// 完全一致(正規化後)で見つからない場合のフォールバック。
// 各aliasの長さ±1の範囲でworkingをスライドさせ、編集距離が閾値以内の最も近い候補を探す。
// 「ラーメソ」のような軽微なタイプミスや、DB未登録の表記ゆれを拾うためのもの。
function findFuzzyBest(working) {
  let best = null;
  for (const dictEntry of DICTIONARY) {
    const alias = dictEntry.normAlias;
    // 短い単語ほど1文字の違いが相対的に大きくなり誤爆しやすいため、
    // 長さに応じて許容編集距離を変える(3文字以下は事実上あいまい検索の対象外)。
    const maxDist = Math.min(2, Math.floor(alias.length / 4));
    if (maxDist < 1) continue;
    for (const len of [alias.length - 1, alias.length, alias.length + 1]) {
      if (len < 2) continue;
      const lenDiff = Math.abs(len - alias.length);
      for (let i = 0; i + len <= working.length; i++) {
        const window = working.slice(i, i + len);
        if (!window.trim()) continue;
        const dist = levenshtein(normalize(window), alias);
        if (dist > maxDist) continue;
        const better = !best || dist < best.dist
          || (dist === best.dist && lenDiff < best.lenDiff)
          || (dist === best.dist && lenDiff === best.lenDiff && i < best.idx);
        if (better) {
          best = { idx: i, matchLen: len, type: dictEntry.type, entry: dictEntry.entry, dist, lenDiff };
        }
      }
    }
  }
  return best;
}

// findFuzzyBestが見つけたおおよその位置(anchorIdx〜anchorIdx+anchorLen)付近について、
// 同じ種類(食品/運動)の候補をエントリごとに最良1件ずつ集め、距離の近い順に最大maxCandidates件返す。
// ユーザーに選ばせるための候補一覧であり、1件に自動確定させないためのもの。
function findFuzzyCandidates(working, category, anchorIdx, anchorLen, maxCandidates = 3) {
  const bestPerEntry = new Map();
  for (const dictEntry of DICTIONARY) {
    if (dictEntry.type !== category) continue;
    const alias = dictEntry.normAlias;
    const maxDist = Math.min(2, Math.floor(alias.length / 4));
    if (maxDist < 1) continue;
    for (const len of [alias.length - 1, alias.length, alias.length + 1]) {
      if (len < 2) continue;
      const lenDiff = Math.abs(len - alias.length);
      const lo = Math.max(0, anchorIdx - 2);
      const hi = Math.min(working.length - len, anchorIdx + anchorLen + 2 - len);
      for (let i = lo; i <= hi; i++) {
        const window = working.slice(i, i + len);
        if (!window.trim()) continue;
        const dist = levenshtein(normalize(window), alias);
        if (dist > maxDist) continue;
        const key = dictEntry.entry.name;
        const existing = bestPerEntry.get(key);
        if (!existing || dist < existing.dist || (dist === existing.dist && lenDiff < existing.lenDiff)) {
          bestPerEntry.set(key, { entry: dictEntry.entry, dist, lenDiff, idx: i });
        }
      }
    }
  }
  const list = Array.from(bestPerEntry.values());
  list.sort((a, b) => a.dist - b.dist || a.lenDiff - b.lenDiff || a.idx - b.idx);
  return list.slice(0, maxCandidates);
}

// 「1/2人前」のような分数表記、「半分」「半人前」を優先的に解釈し、
// それ以外は従来通り小数+単位(0.5人前 等)で判定する。
function parseFoodQuantity(text, idx, end, limit) {
  const fraction = findQuantity(text, idx, end, FOOD_FRACTION_RE, limit);
  if (fraction) {
    const num = parseFloat(fraction.match[1]) / parseFloat(fraction.match[2]);
    return { num, counter: null, matchStart: fraction.matchStart, matchEnd: fraction.matchEnd };
  }

  const half = findQuantity(text, idx, end, FOOD_HALF_RE, limit);
  if (half) {
    return { num: 0.5, counter: null, matchStart: half.matchStart, matchEnd: half.matchEnd };
  }

  const q = findQuantity(text, idx, end, FOOD_COUNTER_RE, limit);
  if (q) {
    return { num: parseFloat(q.match[1]), counter: q.match[2], matchStart: q.matchStart, matchEnd: q.matchEnd };
  }
  return null;
}

function mask(working, start, end) {
  return working.slice(0, start) + ' '.repeat(end - start) + working.slice(end);
}

// 食品エントリと数量情報からログ項目を計算する。exact一致でもpending解決時でも同じ計算式を使う。
function computeFoodItem(f, quantity) {
  let kcal = f.kcal, protein = f.protein, carbs = f.carbs, fat = f.fat;
  // unitが既に数字始まり(例: "100g", "2個(183g)")の場合、"1"を重ねると
  // "12個(183g)"のように数量を誤読させてしまうため、そのまま表示する。
  let qtyLabel = /^\d/.test(f.unit) ? f.unit : `1${f.unit}`;
  if (quantity) {
    const { num, counter } = quantity;
    if ((counter === 'g' || counter === 'グラム') && f.kcalPer100g) {
      const ratio = num / 100;
      kcal = Math.round(f.kcalPer100g * ratio);
      protein = Math.round(f.proteinPer100g * ratio * 10) / 10;
      carbs = Math.round(f.carbsPer100g * ratio * 10) / 10;
      fat = Math.round(f.fatPer100g * ratio * 10) / 10;
      qtyLabel = `${num}g`;
    } else {
      kcal = Math.round(f.kcal * num);
      protein = Math.round(f.protein * num * 10) / 10;
      carbs = Math.round(f.carbs * num * 10) / 10;
      fat = Math.round(f.fat * num * 10) / 10;
      qtyLabel = `${num}${f.unit}`;
    }
  }
  return { type: 'food', name: f.name, qtyLabel, kcal, protein, carbs, fat };
}

// 編集フォームで数量入力から自動再計算するため、保存済みitemのqtyLabelから
// 「g指定だったか(kcalPer100gで按分)」「unit回数指定だったか(f.kcal×num)」を逆算する。
// 判定できない場合(DB未登録の手動項目や、想定外の表記)はnullを返し、手動編集のみに留める。
function parseEditQuantity(item, f) {
  if (!f) return null;
  const label = item.qtyLabel || '';
  const gramMatch = label.match(/^([\d.]+)g$/);
  if (gramMatch && f.kcalPer100g != null) {
    return { num: parseFloat(gramMatch[1]), gram: true };
  }
  const unit = f.unit;
  if (label.endsWith(unit)) {
    const prefix = label.slice(0, label.length - unit.length);
    const n = prefix === '' ? 1 : parseFloat(prefix);
    if (!isNaN(n)) return { num: n, gram: false };
  }
  return null;
}

// parseEditQuantityで判定したモードに従い、新しい数量からkcal/PFC/qtyLabelを再計算する。
function recomputeEditQuantity(f, q) {
  if (q.gram) {
    const ratio = q.num / 100;
    return {
      kcal: Math.round(f.kcalPer100g * ratio),
      protein: Math.round(f.proteinPer100g * ratio * 10) / 10,
      carbs: Math.round(f.carbsPer100g * ratio * 10) / 10,
      fat: Math.round(f.fatPer100g * ratio * 10) / 10,
      qtyLabel: `${q.num}g`,
    };
  }
  return {
    kcal: Math.round(f.kcal * q.num),
    protein: Math.round(f.protein * q.num * 10) / 10,
    carbs: Math.round(f.carbs * q.num * 10) / 10,
    fat: Math.round(f.fat * q.num * 10) / 10,
    qtyLabel: `${q.num}${f.unit}`,
  };
}

// 運動エントリと分数からログ項目を計算する(重量×回数×セットの筋トレ計算は対象外)。
function computeExerciseMinutesItem(e, minutes, bodyweight) {
  const kcal = Math.round(e.met * bodyweight * (minutes / 60) * 1.05);
  return { type: 'exercise', name: e.name, qtyLabel: `${minutes}分`, kcal };
}

// STEPS_REのマッチ結果(万単位グループ or 素の数値グループ)から歩数を数値化する。
function stepsFromMatch(m) {
  if (m[1] !== undefined) {
    const man = parseFloat(m[1]) * 10000;
    const rest = m[2] ? parseFloat(m[2].replace(/,/g, '')) : 0;
    return Math.round(man + rest);
  }
  return Math.round(parseFloat(m[3].replace(/,/g, '')));
}

// メッセージ中に「早歩き」「犬の散歩」の言及があればそちらのMETを使い、
// なければ通常の「ウォーキング」を歩数カロリー計算の対象にする。
function findStepsEntry(normWorking) {
  for (const name of ['早歩き', '犬の散歩']) {
    const entry = EXERCISES.find((e) => e.name === name);
    if (entry && entry.aliases.some((a) => normWorking.includes(normalize(a)))) return entry;
  }
  return EXERCISES.find((e) => e.name === 'ウォーキング');
}

// 歩数から計算した運動項目を既に1件作った後、同じメッセージ中に残っている
// 「ウォーキング」「散歩」等の歩行系の単語をマスクし、二重にカロリーが加算されるのを防ぐ。
function maskWalkAliases(working) {
  let out = working;
  let changed = true;
  while (changed) {
    changed = false;
    const normOut = normalize(out);
    for (const dictEntry of DICTIONARY) {
      if (dictEntry.type !== 'exercise' || !STEPS_WALK_ENTRY_NAMES.includes(dictEntry.entry.name)) continue;
      const idx = normOut.indexOf(dictEntry.normAlias);
      if (idx !== -1) {
        out = mask(out, idx, idx + dictEntry.normAlias.length);
        changed = true;
        break;
      }
    }
  }
  return out;
}

// 全角数字(０-９)を半角に変換する。WEIGHT_RE等の数量系正規表現は\dのみを見るため、
// 全角で入力された「×３」のようなセット数・回数・重量を正しく拾えるようにするための前処理。
function toHalfWidthDigits(str) {
  return str.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

// メッセージ中の左から右へ、最も手前に現れる品目から順に処理する。
// こうすることで、直前の品目が使った数量トークン(例:「白米100gと味噌汁」の"100g")を
// マスクしてから次の品目を探せるため、離れた品目同士で数量が混線しない。
function parseMessage(text, weightKg) {
  let working = toHalfWidthDigits(text);
  const items = [];
  let safety = 30;
  const bodyweightForSteps = weightKg || 60;

  // 「5000歩」「1万歩」のような歩数表記は、通常の品目マッチとは別枠で先に処理する。
  // 単独で書かれた歩数(例: 単に「5000歩」)は辞書のどのエイリアスとも一致しないため、
  // ここで拾っておかないと丸ごと未認識になってしまう。
  const stepsMatch = working.match(STEPS_RE);
  if (stepsMatch) {
    const steps = stepsFromMatch(stepsMatch);
    const minutes = Math.round(steps / STEPS_PER_MINUTE);
    const entry = findStepsEntry(normalize(working));
    const item = computeExerciseMinutesItem(entry, minutes, bodyweightForSteps);
    item.qtyLabel = `${steps.toLocaleString('ja-JP')}歩`;
    items.push(item);
    const stepsEnd = stepsMatch.index + stepsMatch[0].length;
    working = mask(working, stepsMatch.index, stepsEnd);
    // 「5000歩いた/歩いて」のように直後に活用語尾が続く場合はまとめて消費し、
    // 「いた」だけが未認識の残骸として警告に出てしまうのを防ぐ。
    const verbMatch = working.slice(stepsEnd, stepsEnd + 4).match(/^(あるいた|あるいて|いた|いて)/);
    if (verbMatch) working = mask(working, stepsEnd, stepsEnd + verbMatch[0].length);
    working = maskWalkAliases(working);
  }

  while (safety-- > 0) {
    const normWorking = normalize(working);
    let best = null;
    for (const dictEntry of DICTIONARY) {
      const idx = normWorking.indexOf(dictEntry.normAlias);
      if (idx === -1) continue;
      if (!best || idx < best.idx || (idx === best.idx && dictEntry.alias.length > best.matchLen)) {
        best = { idx, matchLen: dictEntry.alias.length, type: dictEntry.type, entry: dictEntry.entry };
      }
    }
    let isExact = true;
    if (!best) {
      best = findFuzzyBest(working);
      isExact = false;
    }
    if (!best) break;

    const { idx, matchLen, type, entry } = best;
    const end = idx + matchLen;
    const limit = findNextMatchIdx(normalize(working), end);

    if (type === 'food') {
      const f = entry;
      const q = parseFoodQuantity(working, idx, end, limit);
      if (q) working = mask(working, q.matchStart, q.matchEnd);

      if (!isExact) {
        // 完全一致ではなくあいまい検索によるヒットのため、1件に確定せず候補として提示する。
        const rawText = working.slice(idx, end);
        const candidates = findFuzzyCandidates(working, 'food', idx, matchLen)
          .map((c) => ({ name: c.entry.name }));
        items.push({
          type: 'pending',
          category: 'food',
          rawText,
          quantity: q ? { num: q.num, counter: q.counter } : null,
          candidates,
        });
      } else {
        items.push(computeFoodItem(f, q ? { num: q.num, counter: q.counter } : null));
      }
    } else {
      const e = entry;
      const bodyweight = weightKg || 60;
      let handledAsStrength = false;

      if (e.strength) {
        const weightMatch = working.match(WEIGHT_RE);
        const repsMatch = working.match(REPS_RE);
        if (weightMatch && repsMatch) {
          const liftedKg = parseFloat(weightMatch[1]);
          const reps = parseInt(repsMatch[1], 10);
          const setsMatch = working.match(SETS_RE);
          const sets = setsMatch ? parseInt(setsMatch[1] || setsMatch[2], 10) : 1;
          const kcal = computeStrengthKcal(e, bodyweight, liftedKg, reps, sets);
          items.push({ type: 'exercise', name: e.name, qtyLabel: `${liftedKg}kg×${reps}回×${sets}セット`, kcal, weightKg: liftedKg, reps, sets });
          working = mask(working, weightMatch.index, weightMatch.index + weightMatch[0].length);
          working = mask(working, repsMatch.index, repsMatch.index + repsMatch[0].length);
          if (setsMatch) working = mask(working, setsMatch.index, setsMatch.index + setsMatch[0].length);
          handledAsStrength = true;
        }
      }

      if (!handledAsStrength) {
        const q = findQuantity(working, idx, end, EXERCISE_COUNTER_RE, limit);
        let minutes = e.defaultMin;
        if (q) {
          minutes = q.match[2] === '時間' || q.match[2] === 'h' ? parseFloat(q.match[1]) * 60 : parseFloat(q.match[1]);
          working = mask(working, q.matchStart, q.matchEnd);
        }

        if (!isExact) {
          const rawText = working.slice(idx, end);
          const candidates = findFuzzyCandidates(working, 'exercise', idx, matchLen)
            .map((c) => ({ name: c.entry.name }));
          items.push({
            type: 'pending',
            category: 'exercise',
            rawText,
            quantity: { minutes },
            candidates,
          });
        } else {
          items.push(computeExerciseMinutesItem(e, minutes, bodyweight));
        }
      }
    }

    working = mask(working, idx, end);
  }

  return { items, hasUnrecognized: hasUnrecognizedLeftover(working) };
}

// マッチ済み部分をマスクした後のテキストに、助詞・句読点・よくある動詞以外の
// まとまった文字列が残っていれば「認識できなかった部分がある」とみなす。
const IGNORABLE_WORDS = ['食べた', '飲んだ', 'たべた', 'のんだ', 'やった', 'した'];
function hasUnrecognizedLeftover(masked) {
  let s = masked;
  for (const w of IGNORABLE_WORDS) s = s.split(w).join('');
  s = s.replace(/[\s、,。・とをはがのでにへも]/g, '');
  return s.trim().length > 0;
}

let data = loadData();
let viewDate = new Date();
let weekAnchor = new Date(viewDate);
let editingKey = null;
let manualAddKey = null;
let pendingManualKey = null;

const menuBtn = document.getElementById('menuBtn');
const menuDropdown = document.getElementById('menuDropdown');
const editProfileBtn = document.getElementById('editProfileBtn');
const dateTitleEl = document.getElementById('dateTitle');
const dateStripEl = document.getElementById('dateStrip');
const weekPrevBtn = document.getElementById('weekPrev');
const weekNextBtn = document.getElementById('weekNext');
const progressFillEl = document.getElementById('progressFill');
const intakeEl = document.getElementById('intakeTotal');
const burnEl = document.getElementById('burnTotal');
const remainingEl = document.getElementById('remainingTotal');
const feedEl = document.getElementById('feed');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('sendBtn');
const inputDateHintEl = document.getElementById('inputDateHint');
const historyPanelEl = document.getElementById('historyPanel');
const historySectionsEl = document.getElementById('historySections');
const foodHistoryChipsEl = document.getElementById('foodHistoryChips');
const exerciseHistoryChipsEl = document.getElementById('exerciseHistoryChips');
const suggestionSectionEl = document.getElementById('suggestionSection');
const suggestionChipsEl = document.getElementById('suggestionChips');
const pfcRingProteinEl = document.getElementById('pfcRingProtein');
const pfcValueProteinEl = document.getElementById('pfcValueProtein');
const pfcRingFatEl = document.getElementById('pfcRingFat');
const pfcValueFatEl = document.getElementById('pfcValueFat');
const pfcRingCarbsEl = document.getElementById('pfcRingCarbs');
const pfcValueCarbsEl = document.getElementById('pfcValueCarbs');
const PFC_RING_CIRCUMFERENCE = 2 * Math.PI * 18;

const statsBtn = document.getElementById('statsBtn');
const statsScreenEl = document.getElementById('statsScreen');
const statsCloseBtn = document.getElementById('statsCloseBtn');
const statsTabEls = Array.from(document.querySelectorAll('.stats-tab'));
const statsAchieveRateEl = document.getElementById('statsAchieveRate');
const statsStreakEl = document.getElementById('statsStreak');
const statsAvgIntakeEl = document.getElementById('statsAvgIntake');
const statsChartEl = document.getElementById('statsChart');
const statsPfcBarsEl = document.getElementById('statsPfcBars');
let statsPeriod = 'week';

const onboardingEl = document.getElementById('onboarding');
const sexInput = document.getElementById('sexInput');
const ageInput = document.getElementById('ageInput');
const heightInput = document.getElementById('heightInput');
const weightInput = document.getElementById('weightInput');
const targetWeightInput = document.getElementById('targetWeightInput');
const activityInput = document.getElementById('activityInput');
const previewGoalEl = document.getElementById('previewGoal');
const saveProfileBtn = document.getElementById('saveProfileBtn');

function startOfWeek(d) {
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function isToday() {
  return dateKey(viewDate) === todayKey();
}

function renderHeader() {
  dateTitleEl.innerHTML = (isToday() ? '今日' : `${viewDate.getMonth() + 1}月${viewDate.getDate()}日`) + ' <span class="chev">▾</span>';
}

function renderDateStrip() {
  dateStripEl.innerHTML = '';
  const monday = startOfWeek(weekAnchor);
  const todayK = todayKey();
  const labels = ['月', '火', '水', '木', '金', '土', '日'];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const key = dateKey(d);
    const cell = document.createElement('button');
    cell.className = 'date-cell';
    const hasLogs = !!(data.days[key] && data.days[key].logs.length > 0);
    if (hasLogs) cell.classList.add('logged');
    if (key === todayK) cell.classList.add('today');
    if (key === dateKey(viewDate)) cell.classList.add('selected');
    cell.innerHTML = `<span class="dow">${labels[i]}</span><span class="dnum">${d.getDate()}日</span>`;
    cell.onclick = () => {
      viewDate = d;
      renderAll();
    };
    dateStripEl.appendChild(cell);
  }
}

function renderSummary() {
  const day = getDay(data, dateKey(viewDate));
  const allItems = day.logs.flatMap((l) => l.items);
  const foodItems = allItems.filter((i) => i.type === 'food');
  const intake = foodItems.reduce((s, i) => s + i.kcal, 0);
  const burn = allItems.filter((i) => i.type === 'exercise').reduce((s, i) => s + i.kcal, 0);
  const goal = computeGoalKcal(data);
  const remaining = goal - intake + burn;

  intakeEl.textContent = intake;
  burnEl.textContent = burn;
  remainingEl.textContent = remaining;

  const pct = Math.max(0, Math.min(100, (intake / goal) * 100));
  progressFillEl.style.width = `${pct}%`;
  progressFillEl.classList.toggle('over', intake - burn > goal);

  const totalProtein = Math.round(foodItems.reduce((s, i) => s + (i.protein || 0), 0));
  const totalFat = Math.round(foodItems.reduce((s, i) => s + (i.fat || 0), 0));
  const totalCarbs = Math.round(foodItems.reduce((s, i) => s + (i.carbs || 0), 0));
  const ideal = computeIdealPFC(goal);
  setPfcRing(pfcRingProteinEl, pfcValueProteinEl, totalProtein, ideal.proteinG);
  setPfcRing(pfcRingFatEl, pfcValueFatEl, totalFat, ideal.fatG);
  setPfcRing(pfcRingCarbsEl, pfcValueCarbsEl, totalCarbs, ideal.carbsG);
}

// 実績/理想の比率に応じてリングの円周を塗りつぶす(理想を超えても100%で頭打ちにするが、
// 超過時はclassを付けて色を濃くし、数値側でも超過分がわかるようにする)。
function setPfcRing(ringEl, valueEl, actual, ideal) {
  const ratio = ideal > 0 ? actual / ideal : 0;
  const pct = Math.min(100, ratio * 100);
  ringEl.style.strokeDashoffset = `${PFC_RING_CIRCUMFERENCE * (1 - pct / 100)}`;
  ringEl.classList.toggle('over', ratio > 1);
  valueEl.textContent = `${actual} / ${ideal}g`;
}

// 指定日のログを集計する。記録が一件もない日はnull(=「未記録日」として達成率・平均から除外するため)。
function getDayLogStats(key) {
  const day = data.days[key];
  if (!day || day.logs.length === 0) return null;
  const allItems = day.logs.flatMap((l) => l.items);
  const foodItems = allItems.filter((i) => i.type === 'food');
  const intake = foodItems.reduce((s, i) => s + i.kcal, 0);
  const burn = allItems.filter((i) => i.type === 'exercise').reduce((s, i) => s + i.kcal, 0);
  const protein = foodItems.reduce((s, i) => s + (i.protein || 0), 0);
  const fat = foodItems.reduce((s, i) => s + (i.fat || 0), 0);
  const carbs = foodItems.reduce((s, i) => s + (i.carbs || 0), 0);
  return { intake, burn, protein, fat, carbs };
}

// 今日から遡って連続で記録がある日数。今日はまだ記録していないだけかもしれないため、
// 今日に記録がなければ昨日を起点にする(未記録の「今日」だけで連続記録が途切れて見えるのを防ぐ)。
function computeStreak() {
  const d = new Date();
  if (!getDayLogStats(dateKey(d))) d.setDate(d.getDate() - 1);
  let streak = 0;
  while (getDayLogStats(dateKey(d))) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

const STATS_DOW_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

// 週間/月間は日次、年間は月次(直近12ヶ月の1日あたり平均)でポイント列を作る。
// goalは現在のプロフィールに基づく現在の目標値を過去日にも一律適用した近似値。
function getStatsSeries(period) {
  const goal = computeGoalKcal(data);
  const now = new Date();
  if (period === 'year') {
    const points = [];
    for (let i = 11; i >= 0; i--) {
      const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const daysInMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate();
      let sums = { intake: 0, burn: 0, protein: 0, fat: 0, carbs: 0 };
      let loggedDays = 0;
      for (let day = 1; day <= daysInMonth; day++) {
        const d = new Date(monthStart.getFullYear(), monthStart.getMonth(), day);
        if (d > now) continue;
        const stats = getDayLogStats(dateKey(d));
        if (!stats) continue;
        loggedDays++;
        for (const k in sums) sums[k] += stats[k];
      }
      const avgIntake = loggedDays ? sums.intake / loggedDays : 0;
      const avgBurn = loggedDays ? sums.burn / loggedDays : 0;
      points.push({
        label: `${monthStart.getMonth() + 1}月`,
        intake: avgIntake,
        burn: avgBurn,
        net: avgIntake - avgBurn,
        protein: loggedDays ? sums.protein / loggedDays : 0,
        fat: loggedDays ? sums.fat / loggedDays : 0,
        carbs: loggedDays ? sums.carbs / loggedDays : 0,
        goal,
        loggedDays,
      });
    }
    return points;
  }
  const numDays = period === 'week' ? 7 : 30;
  const points = [];
  for (let i = numDays - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const stats = getDayLogStats(dateKey(d));
    const intake = stats ? stats.intake : 0;
    const burn = stats ? stats.burn : 0;
    points.push({
      label: period === 'week' ? STATS_DOW_LABELS[d.getDay()] : `${d.getDate()}`,
      intake,
      burn,
      net: intake - burn,
      protein: stats ? stats.protein : 0,
      fat: stats ? stats.fat : 0,
      carbs: stats ? stats.carbs : 0,
      goal,
      loggedDays: stats ? 1 : 0,
    });
  }
  return points;
}

// 達成率=記録がある日のうち、摂取-消費が目標以内に収まっていた日の割合。
function computeAchieveRate(points) {
  const logged = points.filter((p) => p.loggedDays > 0);
  if (logged.length === 0) return null;
  const achieved = logged.filter((p) => p.intake - p.burn <= p.goal).length;
  return Math.round((achieved / logged.length) * 100);
}

function computeAvgIntake(points) {
  const logged = points.filter((p) => p.loggedDays > 0);
  if (logged.length === 0) return null;
  return Math.round(logged.reduce((s, p) => s + p.intake, 0) / logged.length);
}

function renderStatsChart(points) {
  const W = 320;
  const H = 140;
  const padTop = 10;
  const padBottom = 20;
  const padSide = 6;
  const maxVal = Math.max(...points.map((p) => Math.max(p.net, p.goal)), 100) * 1.1;
  const stepX = points.length > 1 ? (W - padSide * 2) / (points.length - 1) : 0;
  const scaleY = (v) => H - padBottom - (v / maxVal) * (H - padTop - padBottom);
  const toPath = (key) => points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${padSide + i * stepX} ${scaleY(p[key]).toFixed(1)}`).join(' ');

  const labelEvery = Math.max(1, Math.ceil(points.length / 6));
  const labels = points.map((p, i) => {
    if (i % labelEvery !== 0 && i !== points.length - 1) return '';
    return `<text x="${padSide + i * stepX}" y="${H - 4}" font-size="8" fill="#8a8f98" text-anchor="middle">${p.label}</text>`;
  }).join('');

  statsChartEl.innerHTML = `
    <path d="${toPath('goal')}" fill="none" stroke="#c2c6cc" stroke-width="1.5" stroke-dasharray="4 3" />
    <path d="${toPath('net')}" fill="none" stroke="#34a853" stroke-width="2.5" />
    ${labels}
  `;
}

function renderStatsPfc(points) {
  const logged = points.filter((p) => p.loggedDays > 0);
  const avg = (key) => (logged.length ? Math.round(logged.reduce((s, p) => s + p[key], 0) / logged.length) : 0);
  const ideal = computeIdealPFC(computeGoalKcal(data));
  const macros = [
    { key: 'protein', label: 'たんぱく質', color: '#e0575b', ideal: ideal.proteinG },
    { key: 'fat', label: '脂質', color: '#e8a33d', ideal: ideal.fatG },
    { key: 'carbs', label: '炭水化物', color: '#3457b2', ideal: ideal.carbsG },
  ];
  statsPfcBarsEl.innerHTML = macros.map((m) => {
    const actual = avg(m.key);
    const pct = m.ideal > 0 ? Math.min(100, (actual / m.ideal) * 100) : 0;
    return `
      <div class="stats-pfc-row">
        <div class="stats-pfc-row-label">${m.label}</div>
        <div class="stats-pfc-row-track"><div class="stats-pfc-row-fill" style="width:${pct}%;background:${m.color}"></div></div>
        <div class="stats-pfc-row-value">${actual} / ${m.ideal}g</div>
      </div>`;
  }).join('');
}

function renderStats() {
  const points = getStatsSeries(statsPeriod);
  const rate = computeAchieveRate(points);
  const avgIntake = computeAvgIntake(points);
  statsAchieveRateEl.textContent = rate === null ? '-' : `${rate}%`;
  statsAvgIntakeEl.textContent = avgIntake === null ? '-' : `${avgIntake}kcal`;
  statsStreakEl.textContent = `${computeStreak()}日`;
  statsTabEls.forEach((t) => t.classList.toggle('active', t.dataset.period === statsPeriod));
  renderStatsChart(points);
  renderStatsPfc(points);
}

function chip(label, value) {
  return `<span class="chip">${label}: ${value}</span>`;
}

function numberField(labelText, value) {
  const wrap = document.createElement('label');
  wrap.className = 'edit-field';
  wrap.textContent = labelText;
  const input = document.createElement('input');
  input.type = 'number';
  input.step = '0.1';
  input.value = value;
  wrap.appendChild(input);
  return { wrap, input };
}

// DB未登録(または一部認識できなかった)入力に対して、ユーザーが手動で品目を追加/確定するためのフォーム。
// replaceIndexを指定すると、新規追加ではなくlog.items[replaceIndex](pending項目)をこの内容で置き換える。
function buildManualAddForm(day, log, logIndex, options = {}) {
  const { replaceIndex = null, prefillName = '', prefillCategory = null, onDone } = options;
  const form = document.createElement('div');
  form.className = 'edit-form';

  const typeWrap = document.createElement('label');
  typeWrap.className = 'edit-field';
  typeWrap.textContent = '種類';
  const typeSelect = document.createElement('select');
  typeSelect.innerHTML = '<option value="food">食事</option><option value="exercise">運動</option>';
  if (prefillCategory) typeSelect.value = prefillCategory;
  typeWrap.appendChild(typeSelect);
  form.appendChild(typeWrap);

  const nameField = numberField('名前', '');
  nameField.input.type = 'text';
  nameField.input.step = null;
  nameField.input.placeholder = '例: 自家製カレー';
  nameField.input.value = prefillName;
  form.appendChild(nameField.wrap);

  const qtyField = numberField('数量表示', '');
  qtyField.input.type = 'text';
  qtyField.input.step = null;
  qtyField.input.placeholder = '例: 1皿 / 20分';
  form.appendChild(qtyField.wrap);

  const kcalField = numberField('カロリー', '');
  form.appendChild(kcalField.wrap);

  const macrosWrap = document.createElement('div');
  const carbsField = numberField('炭水化物(g)', '');
  const proteinField = numberField('タンパク質(g)', '');
  const fatField = numberField('脂質(g)', '');
  macrosWrap.appendChild(carbsField.wrap);
  macrosWrap.appendChild(proteinField.wrap);
  macrosWrap.appendChild(fatField.wrap);
  form.appendChild(macrosWrap);

  macrosWrap.style.display = typeSelect.value === 'food' ? '' : 'none';
  typeSelect.addEventListener('change', () => {
    macrosWrap.style.display = typeSelect.value === 'food' ? '' : 'none';
  });

  const buttons = document.createElement('div');
  buttons.className = 'edit-form-buttons';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'edit-save-btn';
  saveBtn.textContent = replaceIndex != null ? '確定' : '追加';
  saveBtn.onclick = () => {
    const name = nameField.input.value.trim();
    if (!name) {
      alert('名前を入力してください。');
      return;
    }
    const kcal = parseFloat(kcalField.input.value) || 0;
    const qtyLabel = qtyField.input.value.trim() || (typeSelect.value === 'food' ? '1人前' : '手動入力');
    let item;
    if (typeSelect.value === 'food') {
      item = {
        type: 'food',
        name,
        qtyLabel,
        kcal,
        carbs: parseFloat(carbsField.input.value) || 0,
        protein: parseFloat(proteinField.input.value) || 0,
        fat: parseFloat(fatField.input.value) || 0,
      };
    } else {
      item = { type: 'exercise', name, qtyLabel, kcal };
    }
    if (replaceIndex != null) {
      log.items[replaceIndex] = item;
    } else {
      log.items.push(item);
      // ユーザーが手動で内容を補ったので、この警告表示はもう不要。
      log.hasUnrecognized = false;
    }
    if (onDone) onDone();
    saveData(data);
    renderFeed();
    renderSummary();
    renderDateStrip();
  };
  buttons.appendChild(saveBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'edit-cancel-btn';
  cancelBtn.textContent = 'キャンセル';
  cancelBtn.onclick = () => {
    if (onDone) onDone();
    renderFeed();
  };
  buttons.appendChild(cancelBtn);

  form.appendChild(buttons);
  return form;
}

// ユーザーが候補から選んだ品目名で、pending項目を確定した食事/運動ログに置き換える。
function resolvePending(day, log, itemIndex, candidateName) {
  const pending = log.items[itemIndex];
  const bodyweight = data.weightKg || 60;
  let item;
  if (pending.category === 'food') {
    const f = FOODS.find((x) => x.name === candidateName);
    item = computeFoodItem(f, pending.quantity);
  } else {
    const e = EXERCISES.find((x) => x.name === candidateName);
    const minutes = pending.quantity ? pending.quantity.minutes : e.defaultMin;
    item = computeExerciseMinutesItem(e, minutes, bodyweight);
  }
  log.items[itemIndex] = item;
  saveData(data);
  renderFeed();
  renderSummary();
  renderDateStrip();
}

// あいまい検索でヒットした候補を提示し、ユーザーに選んでもらうためのUI。
// どれも当てはまらない場合は手動入力フォームに切り替えられる。
function buildPendingPicker(day, log, logIndex, item, itemIndex, key) {
  const wrap = document.createElement('div');
  wrap.className = 'pending-picker';

  const title = document.createElement('div');
  title.className = 'pending-title';
  title.textContent = `「${item.rawText}」はどれですか?`;
  wrap.appendChild(title);

  const btnRow = document.createElement('div');
  btnRow.className = 'pending-candidates';
  item.candidates.forEach((c) => {
    const btn = document.createElement('button');
    btn.className = 'pending-candidate-btn';
    btn.textContent = c.name;
    btn.onclick = () => resolvePending(day, log, itemIndex, c.name);
    btnRow.appendChild(btn);
  });
  wrap.appendChild(btnRow);

  const bottomRow = document.createElement('div');
  bottomRow.className = 'pending-bottom-row';

  const manualBtn = document.createElement('button');
  manualBtn.className = 'pending-manual-btn';
  manualBtn.textContent = 'この中にない(手動で入力)';
  manualBtn.onclick = () => {
    pendingManualKey = key;
    renderFeed();
  };
  bottomRow.appendChild(manualBtn);

  const delBtn = document.createElement('button');
  delBtn.className = 'log-item-del';
  delBtn.textContent = '✕';
  delBtn.onclick = () => {
    log.items.splice(itemIndex, 1);
    if (log.items.length === 0 && !log.keepEmpty) day.logs.splice(logIndex, 1);
    saveData(data);
    renderFeed();
    renderSummary();
    renderDateStrip();
  };
  bottomRow.appendChild(delBtn);

  wrap.appendChild(bottomRow);
  return wrap;
}

function buildEditForm(day, log, logIndex, item, itemIndex) {
  const form = document.createElement('div');
  form.className = 'edit-form';

  const nameField = numberField('名前', '');
  nameField.input.type = 'text';
  nameField.input.step = null;
  nameField.input.value = item.name;
  form.appendChild(nameField.wrap);

  const qtyField = numberField('数量表示', '');
  qtyField.input.type = 'text';
  qtyField.input.step = null;
  qtyField.input.value = item.qtyLabel;
  form.appendChild(qtyField.wrap);

  const kcalLabel = item.type === 'food' ? 'カロリー' : '消費カロリー';
  const kcalField = numberField(kcalLabel, item.kcal);
  form.appendChild(kcalField.wrap);

  let carbsField, proteinField, fatField;
  if (item.type === 'food') {
    carbsField = numberField('炭水化物(g)', item.carbs);
    form.appendChild(carbsField.wrap);
    proteinField = numberField('タンパク質(g)', item.protein);
    form.appendChild(proteinField.wrap);
    fatField = numberField('脂質(g)', item.fat);
    form.appendChild(fatField.wrap);
  }

  // ── 自動計算欄: 元のDBエントリ(または筋トレの重量/回数/セット)が特定できる場合のみ、
  // 数量を変えるとカロリー/PFCがその場で再計算される数値入力を追加する。
  // DB未登録の手動項目や判定できない表記の場合は追加せず、従来通り各欄を手動編集する。
  let weightField, repsField, setsField;
  if (item.type === 'food') {
    const f = FOODS.find((x) => x.name === item.name);
    const q = f ? parseEditQuantity(item, f) : null;
    if (q) {
      const qtyNumField = numberField(q.gram ? '数量(g)・自動計算' : `数量(${f.unit})・自動計算`, q.num);
      form.insertBefore(qtyNumField.wrap, kcalField.wrap);
      qtyNumField.input.addEventListener('input', () => {
        const num = parseFloat(qtyNumField.input.value);
        if (isNaN(num)) return;
        const r = recomputeEditQuantity(f, { num, gram: q.gram });
        kcalField.input.value = r.kcal;
        carbsField.input.value = r.carbs;
        proteinField.input.value = r.protein;
        fatField.input.value = r.fat;
        qtyField.input.value = r.qtyLabel;
      });
    }
  } else if (item.type === 'exercise') {
    const e = EXERCISES.find((x) => x.name === item.name);
    const bodyweight = data.weightKg || 60;
    if (e && item.weightKg != null && item.reps != null && item.sets != null) {
      weightField = numberField('重量(kg)・自動計算', item.weightKg);
      repsField = numberField('回数・自動計算', item.reps);
      repsField.input.step = '1';
      setsField = numberField('セット数・自動計算', item.sets);
      setsField.input.step = '1';
      [weightField, repsField, setsField].forEach((fld) => form.insertBefore(fld.wrap, kcalField.wrap));
      const recalcStrength = () => {
        const w = parseFloat(weightField.input.value);
        const r = parseInt(repsField.input.value, 10);
        const s = parseInt(setsField.input.value, 10);
        if (isNaN(w) || isNaN(r) || isNaN(s)) return;
        kcalField.input.value = computeStrengthKcal(e, bodyweight, w, r, s);
        qtyField.input.value = `${w}kg×${r}回×${s}セット`;
      };
      weightField.input.addEventListener('input', recalcStrength);
      repsField.input.addEventListener('input', recalcStrength);
      setsField.input.addEventListener('input', recalcStrength);
    } else if (e && !e.strength) {
      const minutesMatch = (item.qtyLabel || '').match(/^([\d.]+)分$/);
      if (minutesMatch) {
        const qtyNumField = numberField('時間(分)・自動計算', parseFloat(minutesMatch[1]));
        form.insertBefore(qtyNumField.wrap, kcalField.wrap);
        qtyNumField.input.addEventListener('input', () => {
          const minutes = parseFloat(qtyNumField.input.value);
          if (isNaN(minutes)) return;
          const r = computeExerciseMinutesItem(e, minutes, bodyweight);
          kcalField.input.value = r.kcal;
          qtyField.input.value = r.qtyLabel;
        });
      }
    }
  }

  const buttons = document.createElement('div');
  buttons.className = 'edit-form-buttons';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'edit-save-btn';
  saveBtn.textContent = '保存';
  saveBtn.onclick = () => {
    item.name = nameField.input.value.trim() || item.name;
    item.qtyLabel = qtyField.input.value.trim() || item.qtyLabel;
    item.kcal = parseFloat(kcalField.input.value) || 0;
    if (item.type === 'food') {
      item.carbs = parseFloat(carbsField.input.value) || 0;
      item.protein = parseFloat(proteinField.input.value) || 0;
      item.fat = parseFloat(fatField.input.value) || 0;
    } else if (weightField && repsField && setsField) {
      item.weightKg = parseFloat(weightField.input.value) || item.weightKg;
      item.reps = parseInt(repsField.input.value, 10) || item.reps;
      item.sets = parseInt(setsField.input.value, 10) || item.sets;
    }
    editingKey = null;
    saveData(data);
    renderFeed();
    renderSummary();
    renderDateStrip();
  };
  buttons.appendChild(saveBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'edit-cancel-btn';
  cancelBtn.textContent = 'キャンセル';
  cancelBtn.onclick = () => {
    editingKey = null;
    renderFeed();
  };
  buttons.appendChild(cancelBtn);

  form.appendChild(buttons);
  return form;
}

function renderFeed() {
  feedEl.innerHTML = '';
  const day = getDay(data, dateKey(viewDate));

  if (day.logs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'まだ記録がありません。下の入力欄から食事や運動を送ってみましょう。';
    feedEl.appendChild(empty);
    return;
  }

  day.logs.forEach((log, logIndex) => {
    const card = document.createElement('div');
    card.className = 'log-card';

    const raw = document.createElement('div');
    raw.className = 'log-raw';
    raw.textContent = log.text;
    card.appendChild(raw);

    // 候補ピッカー(pending項目)が既に出ている場合、そちらの「この中にない(手動で入力)」で
    // 手動対応の導線は足りているため、ログ全体向けの「+ 手動で追加」は二重で出さない。
    const hasPending = log.items.some((it) => it.type === 'pending');

    if (log.items.length === 0) {
      const notFound = document.createElement('div');
      notFound.className = 'log-not-found';
      notFound.textContent = '認識できませんでした(DB未登録の可能性があります)';
      card.appendChild(notFound);
    } else if (log.hasUnrecognized && !hasPending) {
      const partial = document.createElement('div');
      partial.className = 'log-not-found';
      partial.textContent = '一部、認識できなかった内容があります';
      card.appendChild(partial);
    }

    if (log.items.length === 0 || (log.hasUnrecognized && !hasPending)) {
      if (manualAddKey === logIndex) {
        const manualForm = document.createElement('div');
        manualForm.className = 'log-item';
        manualForm.appendChild(buildManualAddForm(day, log, logIndex, {
          onDone: () => { manualAddKey = null; },
        }));
        card.appendChild(manualForm);
      } else {
        const actionRow = document.createElement('div');
        actionRow.className = 'log-action-row';
        let hasAction = false;

        if (!log.manualDismissed) {
          const manualBtn = document.createElement('button');
          manualBtn.className = 'manual-add-btn';
          manualBtn.textContent = '+ 手動で追加';
          manualBtn.onclick = () => {
            manualAddKey = logIndex;
            renderFeed();
          };
          actionRow.appendChild(manualBtn);

          // 手動入力するつもりがない場合に、このボタンだけを個別に消せるようにする。
          // ログ自体(✕ 削除)とは別の操作。
          const dismissBtn = document.createElement('button');
          dismissBtn.className = 'manual-dismiss-btn';
          dismissBtn.textContent = '✕';
          dismissBtn.title = '手動入力ボタンを消す';
          dismissBtn.onclick = () => {
            log.manualDismissed = true;
            saveData(data);
            renderFeed();
          };
          actionRow.appendChild(dismissBtn);
          hasAction = true;
        }

        if (log.items.length === 0) {
          const deleteLogBtn = document.createElement('button');
          deleteLogBtn.className = 'log-delete-btn';
          deleteLogBtn.textContent = '✕ 削除';
          deleteLogBtn.onclick = () => {
            day.logs.splice(logIndex, 1);
            saveData(data);
            renderFeed();
            renderSummary();
            renderDateStrip();
          };
          actionRow.appendChild(deleteLogBtn);
          hasAction = true;
        }

        if (hasAction) card.appendChild(actionRow);
      }
    }

    log.items.forEach((item, itemIndex) => {
      const key = `${logIndex}:${itemIndex}`;
      const row = document.createElement('div');
      row.className = 'log-item';

      if (item.type === 'pending') {
        if (pendingManualKey === key) {
          row.appendChild(buildManualAddForm(day, log, logIndex, {
            replaceIndex: itemIndex,
            prefillName: item.rawText,
            prefillCategory: item.category,
            onDone: () => { pendingManualKey = null; },
          }));
        } else {
          row.appendChild(buildPendingPicker(day, log, logIndex, item, itemIndex, key));
        }
        card.appendChild(row);
        return;
      }

      if (editingKey === key) {
        row.appendChild(buildEditForm(day, log, logIndex, item, itemIndex));
        card.appendChild(row);
        return;
      }

      const title = document.createElement('div');
      title.className = 'log-item-title';
      title.innerHTML = `<span>${item.type === 'food' ? '🍚' : '🏃'} ${item.name} (${item.qtyLabel})</span>`;

      const actions = document.createElement('span');
      actions.className = 'log-item-actions';

      const edit = document.createElement('button');
      edit.className = 'log-item-edit';
      edit.textContent = '✎';
      edit.onclick = () => {
        editingKey = key;
        renderFeed();
      };
      actions.appendChild(edit);

      const del = document.createElement('button');
      del.className = 'log-item-del';
      del.textContent = '✕';
      del.onclick = () => {
        log.items.splice(itemIndex, 1);
        if (log.items.length === 0 && !log.keepEmpty) day.logs.splice(logIndex, 1);
        saveData(data);
        renderFeed();
        renderSummary();
        renderDateStrip();
      };
      actions.appendChild(del);
      title.appendChild(actions);
      row.appendChild(title);

      const chips = document.createElement('div');
      chips.className = 'chips';
      if (item.type === 'food') {
        chips.innerHTML = chip('カロリー', item.kcal) + chip('炭水化物', `${item.carbs}g`) + chip('タンパク質', `${item.protein}g`) + chip('脂質', `${item.fat}g`);
      } else if (item.weightKg) {
        chips.innerHTML = chip('消費カロリー', item.kcal) + chip('重量', `${item.weightKg}kg`) + chip('回数', `${item.reps}回`) + chip('セット', item.sets);
      } else {
        const qtyLabelName = item.qtyLabel.endsWith('歩') ? '歩数' : '時間';
        chips.innerHTML = chip('消費カロリー', item.kcal) + chip(qtyLabelName, item.qtyLabel);
      }
      row.appendChild(chips);
      card.appendChild(row);
    });

    feedEl.appendChild(card);
  });
}

function renderAll() {
  renderHeader();
  renderDateStrip();
  renderSummary();
  renderFeed();
  if (isToday()) {
    inputDateHintEl.classList.remove('visible');
  } else {
    inputDateHintEl.textContent = `${viewDate.getMonth() + 1}月${viewDate.getDate()}日の記録として追加します`;
    inputDateHintEl.classList.add('visible');
  }
}

function sendMessage() {
  const text = inputEl.value.trim();
  if (!text) return;
  const day = getDay(data, dateKey(viewDate));
  const { items, hasUnrecognized } = parseMessage(text, data.weightKg);
  day.logs.push({ text, items, hasUnrecognized });
  saveData(data);
  inputEl.value = '';
  historyPanelEl.classList.remove('open');
  renderSummary();
  renderFeed();
  renderDateStrip();
}

sendBtn.addEventListener('click', sendMessage);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// 全日程を新しい順に見て、食事/運動それぞれ直近の異なる入力文を最大10件集める。
function getHistory() {
  const foodTexts = [];
  const exerciseTexts = [];
  const dayKeys = Object.keys(data.days).sort().reverse();
  for (const key of dayKeys) {
    const day = data.days[key];
    for (let i = day.logs.length - 1; i >= 0; i--) {
      const log = day.logs[i];
      if (!log.items || log.items.length === 0 || !log.text) continue;
      const hasFood = log.items.some((it) => it.type === 'food');
      const hasExercise = log.items.some((it) => it.type === 'exercise');
      if (hasFood && foodTexts.length < 10 && !foodTexts.includes(log.text)) foodTexts.push(log.text);
      if (hasExercise && exerciseTexts.length < 10 && !exerciseTexts.includes(log.text)) exerciseTexts.push(log.text);
    }
    if (foodTexts.length >= 10 && exerciseTexts.length >= 10) break;
  }
  return { foodTexts, exerciseTexts };
}

function fillFromHistory(text) {
  inputEl.value = text;
  historyPanelEl.classList.remove('open');
  inputEl.focus();
}

function renderHistoryChips(container, texts) {
  container.innerHTML = '';
  if (texts.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'history-empty';
    empty.textContent = 'まだ記録がありません';
    container.appendChild(empty);
    return;
  }
  texts.forEach((t) => {
    const chip = document.createElement('button');
    chip.className = 'history-chip';
    chip.textContent = t;
    chip.onmousedown = (e) => e.preventDefault();
    chip.onclick = () => fillFromHistory(t);
    container.appendChild(chip);
  });
}

function renderHistoryPanel() {
  const { foodTexts, exerciseTexts } = getHistory();
  renderHistoryChips(foodHistoryChipsEl, foodTexts);
  renderHistoryChips(exerciseHistoryChipsEl, exerciseTexts);
}

// 入力中の内容から候補チップを表示する。末尾に一致する品目がなければ
// (入力が空、または数量だけ打っている等)最近の履歴表示に戻す。
function applySuggestion(name, suffixLen) {
  const raw = inputEl.value;
  inputEl.value = raw.slice(0, raw.length - suffixLen) + name;
  sendMessage();
  inputEl.focus();
}

function renderSuggestions() {
  const raw = inputEl.value;
  if (!raw.trim()) {
    historySectionsEl.style.display = '';
    suggestionSectionEl.style.display = 'none';
    renderHistoryPanel();
    historyPanelEl.classList.add('open');
    return;
  }
  const { suffixLen, matches } = computeLiveSuggestions(raw);
  if (matches.length === 0) {
    historyPanelEl.classList.remove('open');
    return;
  }
  historySectionsEl.style.display = 'none';
  suggestionSectionEl.style.display = 'block';
  suggestionChipsEl.innerHTML = '';
  matches.forEach((m) => {
    const chipBtn = document.createElement('button');
    chipBtn.className = 'history-chip suggestion-chip';
    chipBtn.textContent = `${m.type === 'food' ? '🍚' : '🏃'} ${m.entry.name}`;
    chipBtn.onmousedown = (e) => e.preventDefault();
    chipBtn.onclick = () => applySuggestion(m.entry.name, suffixLen);
    suggestionChipsEl.appendChild(chipBtn);
  });
  historyPanelEl.classList.add('open');
}

let suggestDebounceTimer = null;
inputEl.addEventListener('input', () => {
  clearTimeout(suggestDebounceTimer);
  suggestDebounceTimer = setTimeout(renderSuggestions, 80);
});

inputEl.addEventListener('focus', () => {
  renderSuggestions();
});

inputEl.addEventListener('blur', () => {
  setTimeout(() => historyPanelEl.classList.remove('open'), 150);
});

dateTitleEl.addEventListener('click', () => {
  viewDate = new Date();
  weekAnchor = new Date(viewDate);
  renderAll();
});

weekPrevBtn.addEventListener('click', () => {
  weekAnchor.setDate(weekAnchor.getDate() - 7);
  weekAnchor = new Date(weekAnchor);
  renderDateStrip();
});

weekNextBtn.addEventListener('click', () => {
  weekAnchor.setDate(weekAnchor.getDate() + 7);
  weekAnchor = new Date(weekAnchor);
  renderDateStrip();
});

menuBtn.addEventListener('click', () => {
  menuDropdown.classList.toggle('open');
});

editProfileBtn.addEventListener('click', () => {
  menuDropdown.classList.remove('open');
  openOnboarding();
});

statsBtn.addEventListener('click', () => {
  menuDropdown.classList.remove('open');
  statsScreenEl.classList.add('open');
  renderStats();
});

statsCloseBtn.addEventListener('click', () => {
  statsScreenEl.classList.remove('open');
});

statsTabEls.forEach((t) => {
  t.addEventListener('click', () => {
    statsPeriod = t.dataset.period;
    renderStats();
  });
});

function updatePreviewGoal() {
  const draft = {
    sex: sexInput.value,
    age: parseFloat(ageInput.value) || null,
    heightCm: parseFloat(heightInput.value) || null,
    weightKg: parseFloat(weightInput.value) || null,
    targetWeightKg: parseFloat(targetWeightInput.value) || null,
    activityLevel: activityInput.value,
  };
  if (hasProfile(draft)) {
    previewGoalEl.textContent = `目標カロリー: ${computeGoalKcal(draft)}kcal(自動計算)`;
  } else {
    previewGoalEl.textContent = '';
  }
}

[sexInput, ageInput, heightInput, weightInput, targetWeightInput, activityInput].forEach((el) => {
  el.addEventListener('input', updatePreviewGoal);
});

function openOnboarding() {
  if (data.sex) sexInput.value = data.sex;
  if (data.age) ageInput.value = data.age;
  if (data.heightCm) heightInput.value = data.heightCm;
  if (data.weightKg) weightInput.value = data.weightKg;
  if (data.targetWeightKg) targetWeightInput.value = data.targetWeightKg;
  activityInput.value = data.activityLevel || 'light';
  updatePreviewGoal();
  onboardingEl.classList.add('open');
}

saveProfileBtn.addEventListener('click', () => {
  const age = parseFloat(ageInput.value);
  const heightCm = parseFloat(heightInput.value);
  const weightKg = parseFloat(weightInput.value);
  if (!age || !heightCm || !weightKg) {
    alert('年齢・身長・体重は必須です。');
    return;
  }
  data.sex = sexInput.value;
  data.age = age;
  data.heightCm = heightCm;
  data.weightKg = weightKg;
  data.targetWeightKg = parseFloat(targetWeightInput.value) || null;
  data.activityLevel = activityInput.value;
  saveData(data);
  onboardingEl.classList.remove('open');
  renderSummary();
});

if (!hasProfile(data)) {
  openOnboarding();
}
renderAll();
