// ── 设备电池容量库（充满预测用）──
//
// 充电器读不到被充设备的电量与型号（PD/PPS/UFCS 协议不传这些），所以"从多少 %
// 充到多少 %"必须有一个容量做分母。这里内置常见设备的电池容量，用户按
// 品牌 → 系列 → 型号 三级选，或者直接搜型号（搜 "15 pro" 也能命中）。
//
// 数据口径：
//   · 手机/耳机/手表给额定容量 mAh，Wh 按标称电压折算（手机 3.85V、充电宝 3.7V）
//     —— 厂商标称的 "典型值" 与额定值差 2~3%，属于估算可接受范围。
//   · 笔记本/平板/掌机厂商标的就是 Wh，直接给 Wh。
//
// 分组约定（重要）：
//   · **一代一个系列**，绝不跨代合并。iPhone 14 和 iPhone 13 是两个系列，
//     不能写成 "iPhone 14 / 13 系列"——否则用户在下拉里按系列找机器时会漏。
//   · 系列名只写系列，不掺型号（"iPhone 13 系列" 而不是 "iPhone 12 / SE"）。
//   · 覆盖 2021–2026 近五年主流机型；所有数字都是"约"，用于估算时长，
//     不用于计费或质保判定。
//
// 结构：{ b: 品牌, s: 系列, m: [型号...] }，型号是 { n: 名称, mah } 或 { n, wh }。

(function (global) {
    'use strict';

    var V_PHONE = 3.85;   // 手机锂电标称电压
    var V_PB = 3.7;       // 充电宝电芯标称电压

    var DB = [
        // ───────── Apple 苹果 ─────────
        { b: 'Apple 苹果', s: 'iPhone 17 系列', m: [
            { n: 'iPhone 17 Pro Max', mah: 5088 },
            { n: 'iPhone 17 Pro', mah: 4252 },
            { n: 'iPhone 17', mah: 3692 },
            { n: 'iPhone Air', mah: 3149 }
        ] },
        { b: 'Apple 苹果', s: 'iPhone 16 系列', m: [
            { n: 'iPhone 16 Pro Max', mah: 4685 },
            { n: 'iPhone 16 Plus', mah: 4674 },
            { n: 'iPhone 16 Pro', mah: 3582 },
            { n: 'iPhone 16', mah: 3561 },
            { n: 'iPhone 16e', mah: 4005 }
        ] },
        { b: 'Apple 苹果', s: 'iPhone 15 系列', m: [
            { n: 'iPhone 15 Pro Max', mah: 4441 },
            { n: 'iPhone 15 Plus', mah: 4383 },
            { n: 'iPhone 15 Pro', mah: 3274 },
            { n: 'iPhone 15', mah: 3349 }
        ] },
        { b: 'Apple 苹果', s: 'iPhone 14 系列', m: [
            { n: 'iPhone 14 Pro Max', mah: 4323 },
            { n: 'iPhone 14 Plus', mah: 4325 },
            { n: 'iPhone 14 Pro', mah: 3200 },
            { n: 'iPhone 14', mah: 3279 }
        ] },
        { b: 'Apple 苹果', s: 'iPhone 13 系列', m: [
            { n: 'iPhone 13 Pro Max', mah: 4352 },
            { n: 'iPhone 13 Pro', mah: 3095 },
            { n: 'iPhone 13', mah: 3227 },
            { n: 'iPhone 13 mini', mah: 2406 }
        ] },
        { b: 'Apple 苹果', s: 'iPhone 12 系列', m: [
            { n: 'iPhone 12 Pro Max', mah: 3687 },
            { n: 'iPhone 12 Pro', mah: 2815 },
            { n: 'iPhone 12', mah: 2815 },
            { n: 'iPhone 12 mini', mah: 2227 }
        ] },
        { b: 'Apple 苹果', s: 'iPhone 11 系列', m: [
            { n: 'iPhone 11 Pro Max', mah: 3969 },
            { n: 'iPhone 11 Pro', mah: 3046 },
            { n: 'iPhone 11', mah: 3110 }
        ] },
        { b: 'Apple 苹果', s: 'iPhone SE 系列', m: [
            { n: 'iPhone SE（第 3 代）', mah: 2018 },
            { n: 'iPhone SE（第 2 代）', mah: 1821 }
        ] },
        { b: 'Apple 苹果', s: 'iPhone X 系列', m: [
            { n: 'iPhone XS Max', mah: 3174 },
            { n: 'iPhone XS', mah: 2658 },
            { n: 'iPhone XR', mah: 2942 },
            { n: 'iPhone X', mah: 2716 }
        ] },
        { b: 'Apple 苹果', s: 'iPad Pro 系列', m: [
            { n: 'iPad Pro 13" (M4)', wh: 38.99 },
            { n: 'iPad Pro 11" (M4)', wh: 31.29 },
            { n: 'iPad Pro 12.9" (M1/M2)', wh: 40.88 },
            { n: 'iPad Pro 11" (M1/M2)', wh: 26.53 }
        ] },
        { b: 'Apple 苹果', s: 'iPad Air 系列', m: [
            { n: 'iPad Air 13" (M2/M3)', wh: 36.59 },
            { n: 'iPad Air 11" (M2/M3)', wh: 28.93 },
            { n: 'iPad Air (M1)', wh: 28.93 }
        ] },
        { b: 'Apple 苹果', s: 'iPad 数字系列', m: [
            { n: 'iPad (第 11 代)', wh: 28.9 },
            { n: 'iPad (第 10 代)', wh: 28.93 },
            { n: 'iPad (第 9 代)', wh: 32.4 }
        ] },
        { b: 'Apple 苹果', s: 'iPad mini 系列', m: [
            { n: 'iPad mini (A17 Pro / 7)', wh: 19.19 },
            { n: 'iPad mini 6', wh: 19.19 }
        ] },
        { b: 'Apple 苹果', s: 'MacBook Air 系列', m: [
            { n: 'MacBook Air 13" M4', wh: 53.8 },
            { n: 'MacBook Air 13" M3', wh: 52.6 },
            { n: 'MacBook Air 13" M2', wh: 52.6 },
            { n: 'MacBook Air 13" M1', wh: 49.9 },
            { n: 'MacBook Air 15" M3/M4', wh: 66.5 }
        ] },
        { b: 'Apple 苹果', s: 'MacBook Pro 系列', m: [
            { n: 'MacBook Pro 14" M4', wh: 72.4 },
            { n: 'MacBook Pro 14" M3', wh: 69.5 },
            { n: 'MacBook Pro 14" M1/M2 Pro', wh: 69.5 },
            { n: 'MacBook Pro 16" M4', wh: 100.0 },
            { n: 'MacBook Pro 16" M1–M3', wh: 99.8 },
            { n: 'MacBook Pro 13" M2', wh: 58.2 }
        ] },
        { b: 'Apple 苹果', s: 'AirPods 系列', m: [
            { n: 'AirPods Pro 2（含充电盒）', wh: 1.9 },
            { n: 'AirPods Pro 1（含充电盒）', wh: 1.7 },
            { n: 'AirPods 4（含充电盒）', wh: 1.4 },
            { n: 'AirPods 3（含充电盒）', wh: 1.6 },
            { n: 'AirPods 2（含充电盒）', wh: 1.5 },
            { n: 'AirPods Max（含盒）', wh: 1.5 }
        ] },
        { b: 'Apple 苹果', s: 'Apple Watch 系列', m: [
            { n: 'Apple Watch Series 10', wh: 1.27 },
            { n: 'Apple Watch Series 9', wh: 1.72 },
            { n: 'Apple Watch Series 8', wh: 1.61 },
            { n: 'Apple Watch Series 7', wh: 1.61 },
            { n: 'Apple Watch SE 2', wh: 1.29 },
            { n: 'Apple Watch Ultra 2', wh: 2.15 },
            { n: 'Apple Watch Ultra 1', wh: 2.09 }
        ] },

        // ───────── 小米 / Redmi ─────────
        { b: '小米 Xiaomi', s: '小米 17 系列', m: [
            { n: '小米 17 Pro Max', mah: 7500 },
            { n: '小米 17 Pro', mah: 6300 },
            { n: '小米 17', mah: 7000 }
        ] },
        { b: '小米 Xiaomi', s: '小米 15 系列', m: [
            { n: '小米 15 Ultra', mah: 6000 },
            { n: '小米 15 Pro', mah: 6100 },
            { n: '小米 15', mah: 5400 }
        ] },
        { b: '小米 Xiaomi', s: '小米 14 系列', m: [
            { n: '小米 14 Ultra', mah: 5300 },
            { n: '小米 14 Pro', mah: 4880 },
            { n: '小米 14', mah: 4610 }
        ] },
        { b: '小米 Xiaomi', s: '小米 13 系列', m: [
            { n: '小米 13 Ultra', mah: 5000 },
            { n: '小米 13 Pro', mah: 4820 },
            { n: '小米 13', mah: 4500 }
        ] },
        { b: '小米 Xiaomi', s: '小米 12 系列', m: [
            { n: '小米 12S Ultra', mah: 4860 },
            { n: '小米 12S Pro', mah: 4600 },
            { n: '小米 12S', mah: 4500 },
            { n: '小米 12 Pro', mah: 4600 },
            { n: '小米 12', mah: 4500 },
            { n: '小米 12X', mah: 4500 }
        ] },
        { b: '小米 Xiaomi', s: '小米 11 系列', m: [
            { n: '小米 11 Ultra', mah: 5000 },
            { n: '小米 11 Pro', mah: 5000 },
            { n: '小米 11 青春版', mah: 4250 },
            { n: '小米 11', mah: 4600 }
        ] },
        { b: '小米 Xiaomi', s: '小米 Civi 系列', m: [
            { n: '小米 Civi 5 Pro', mah: 6000 },
            { n: '小米 Civi 4 Pro', mah: 4700 },
            { n: '小米 Civi 3', mah: 4700 },
            { n: '小米 Civi 2', mah: 4500 },
            { n: '小米 Civi 1S', mah: 4500 },
            { n: '小米 Civi', mah: 4500 }
        ] },
        { b: '小米 Xiaomi', s: 'Redmi K80 系列', m: [
            { n: 'Redmi K80 Pro', mah: 6000 },
            { n: 'Redmi K80', mah: 6550 }
        ] },
        { b: '小米 Xiaomi', s: 'Redmi K70 系列', m: [
            { n: 'Redmi K70 至尊版', mah: 5500 },
            { n: 'Redmi K70 Pro', mah: 5000 },
            { n: 'Redmi K70', mah: 5000 }
        ] },
        { b: '小米 Xiaomi', s: 'Redmi K60 系列', m: [
            { n: 'Redmi K60 至尊版', mah: 5000 },
            { n: 'Redmi K60 Pro', mah: 5000 },
            { n: 'Redmi K60', mah: 5500 }
        ] },
        { b: '小米 Xiaomi', s: 'Redmi K50 系列', m: [
            { n: 'Redmi K50 至尊版', mah: 5000 },
            { n: 'Redmi K50 Pro', mah: 5000 },
            { n: 'Redmi K50', mah: 5500 }
        ] },
        { b: '小米 Xiaomi', s: 'Redmi K40 系列', m: [
            { n: 'Redmi K40 游戏增强版', mah: 5065 },
            { n: 'Redmi K40 Pro', mah: 4520 },
            { n: 'Redmi K40', mah: 4520 }
        ] },
        { b: '小米 Xiaomi', s: 'Redmi Note 14 系列', m: [
            { n: 'Redmi Note 14 Pro+', mah: 5500 },
            { n: 'Redmi Note 14 Pro', mah: 5500 },
            { n: 'Redmi Note 14', mah: 5100 }
        ] },
        { b: '小米 Xiaomi', s: 'Redmi Note 13 系列', m: [
            { n: 'Redmi Note 13 Pro+', mah: 5000 },
            { n: 'Redmi Note 13 Pro', mah: 5100 }
        ] },
        { b: '小米 Xiaomi', s: 'Redmi Note 12 系列', m: [
            { n: 'Redmi Note 12 Turbo', mah: 5000 },
            { n: 'Redmi Note 12 Pro', mah: 5000 }
        ] },
        { b: '小米 Xiaomi', s: 'Redmi Note 11 系列', m: [
            { n: 'Redmi Note 11T Pro', mah: 5080 },
            { n: 'Redmi Note 11 Pro', mah: 5160 }
        ] },
        { b: '小米 Xiaomi', s: 'Redmi Note 10 系列', m: [
            { n: 'Redmi Note 10 Pro', mah: 5000 }
        ] },
        { b: '小米 Xiaomi', s: 'Redmi Turbo 系列', m: [
            { n: 'Redmi Turbo 4', mah: 6550 },
            { n: 'Redmi Turbo 3', mah: 5000 }
        ] },
        { b: '小米 Xiaomi', s: '小米平板 7 系列', m: [
            { n: '小米平板 7 Pro', mah: 10000 },
            { n: '小米平板 7', mah: 8850 }
        ] },
        { b: '小米 Xiaomi', s: '小米平板 6 系列', m: [
            { n: '小米平板 6S Pro', mah: 10000 },
            { n: '小米平板 6 Pro', mah: 8600 },
            { n: '小米平板 6', mah: 8840 }
        ] },
        { b: '小米 Xiaomi', s: '小米平板 5 系列', m: [
            { n: '小米平板 5 Pro', mah: 8600 },
            { n: '小米平板 5', mah: 8720 }
        ] },
        { b: '小米 Xiaomi', s: 'Redmi Pad 系列', m: [
            { n: 'Redmi Pad Pro', mah: 10000 },
            { n: 'Redmi Pad SE', mah: 8000 },
            { n: 'Redmi Pad', mah: 8000 }
        ] },
        { b: '小米 Xiaomi', s: '小米笔记本系列', m: [
            { n: '小米笔记本 Pro 16', wh: 85.0 },
            { n: 'RedmiBook Pro 15', wh: 70.0 },
            { n: 'RedmiBook Pro 14', wh: 56.0 }
        ] },
        { b: '小米 Xiaomi', s: '小米穿戴系列', m: [
            { n: '小米手表 S3', wh: 1.6 },
            { n: '小米 Watch H Pro', wh: 1.8 },
            { n: '小米 Buds 4 Pro（含盒）', wh: 1.9 },
            { n: '小米 Buds 5（含盒）', wh: 1.6 }
        ] },

        // ───────── 华为 ─────────
        { b: '华为 Huawei', s: 'Mate 70 系列', m: [
            { n: 'Mate 70 Pro+', mah: 5500 },
            { n: 'Mate 70 Pro', mah: 5500 },
            { n: 'Mate 70', mah: 5300 }
        ] },
        { b: '华为 Huawei', s: 'Mate 60 系列', m: [
            { n: 'Mate 60 Pro+', mah: 5000 },
            { n: 'Mate 60 Pro', mah: 5000 },
            { n: 'Mate 60', mah: 4750 }
        ] },
        { b: '华为 Huawei', s: 'Mate 50 系列', m: [
            { n: 'Mate 50 Pro', mah: 4700 },
            { n: 'Mate 50', mah: 4460 }
        ] },
        { b: '华为 Huawei', s: 'Mate 40 系列', m: [
            { n: 'Mate 40 Pro', mah: 4400 },
            { n: 'Mate 40', mah: 4200 }
        ] },
        { b: '华为 Huawei', s: 'Pura 70 系列', m: [
            { n: 'Pura 70 Ultra', mah: 5200 },
            { n: 'Pura 70 Pro+', mah: 5050 },
            { n: 'Pura 70 Pro', mah: 5050 },
            { n: 'Pura 70', mah: 4900 }
        ] },
        { b: '华为 Huawei', s: 'P60 系列', m: [
            { n: 'P60 Pro', mah: 4815 },
            { n: 'P60', mah: 4810 }
        ] },
        { b: '华为 Huawei', s: 'P50 系列', m: [
            { n: 'P50 Pro', mah: 4360 },
            { n: 'P50', mah: 4100 }
        ] },
        { b: '华为 Huawei', s: 'nova 13 系列', m: [
            { n: 'nova 13 Pro', mah: 5000 },
            { n: 'nova 13', mah: 5000 }
        ] },
        { b: '华为 Huawei', s: 'nova 12 系列', m: [
            { n: 'nova 12 Ultra', mah: 4600 },
            { n: 'nova 12 Pro', mah: 4600 },
            { n: 'nova 12', mah: 4600 }
        ] },
        { b: '华为 Huawei', s: 'nova 11 系列', m: [
            { n: 'nova 11 Pro', mah: 4500 },
            { n: 'nova 11', mah: 4500 }
        ] },
        { b: '华为 Huawei', s: 'nova 10 系列', m: [
            { n: 'nova 10 Pro', mah: 4500 },
            { n: 'nova 10', mah: 4000 }
        ] },
        { b: '华为 Huawei', s: 'nova 9 系列', m: [
            { n: 'nova 9', mah: 4300 }
        ] },
        { b: '华为 Huawei', s: 'Mate X 折叠系列', m: [
            { n: 'Mate X6（折叠）', mah: 5110 },
            { n: 'Mate X5（折叠）', mah: 5060 },
            { n: 'Mate X3（折叠）', mah: 4800 },
            { n: 'Mate X2（折叠）', mah: 4400 }
        ] },
        { b: '华为 Huawei', s: 'Pocket 折叠系列', m: [
            { n: 'Pocket 2', mah: 4520 },
            { n: 'P50 Pocket', mah: 4000 }
        ] },
        { b: '华为 Huawei', s: 'MatePad 系列', m: [
            { n: 'MatePad Pro 13.2"', mah: 10100 },
            { n: 'MatePad Pro 12.6"', mah: 10050 },
            { n: 'MatePad Pro 11"', mah: 8300 },
            { n: 'MatePad 11.5"', mah: 8800 }
        ] },
        { b: '华为 Huawei', s: 'MateBook 系列', m: [
            { n: 'MateBook X Pro', wh: 70.0 },
            { n: 'MateBook 16s', wh: 70.0 },
            { n: 'MateBook 14s', wh: 60.0 },
            { n: 'MateBook 14', wh: 60.0 }
        ] },
        { b: '华为 Huawei', s: '华为穿戴系列', m: [
            { n: 'FreeBuds Pro 4（含盒）', wh: 2.0 },
            { n: 'FreeBuds Pro 3（含盒）', wh: 1.9 },
            { n: 'FreeBuds 5（含盒）', wh: 1.5 },
            { n: 'Watch GT 5 Pro', wh: 2.3 },
            { n: 'Watch GT 5', wh: 2.0 },
            { n: 'Watch GT 4', wh: 1.8 },
            { n: 'Watch 4 Pro', wh: 2.0 }
        ] },

        // ───────── 荣耀 ─────────
        { b: '荣耀 HONOR', s: 'Magic8 系列', m: [
            { n: 'Magic8 Pro', mah: 7200 },
            { n: 'Magic8', mah: 7000 }
        ] },
        { b: '荣耀 HONOR', s: 'Magic7 系列', m: [
            { n: 'Magic7 Pro', mah: 5850 },
            { n: 'Magic7', mah: 5650 }
        ] },
        { b: '荣耀 HONOR', s: 'Magic6 系列', m: [
            { n: 'Magic6 至臻版', mah: 5600 },
            { n: 'Magic6 Pro', mah: 5600 },
            { n: 'Magic6', mah: 5450 }
        ] },
        { b: '荣耀 HONOR', s: 'Magic5 系列', m: [
            { n: 'Magic5 至臻版', mah: 5450 },
            { n: 'Magic5 Pro', mah: 5450 },
            { n: 'Magic5', mah: 5100 }
        ] },
        { b: '荣耀 HONOR', s: 'Magic4 系列', m: [
            { n: 'Magic4 Pro', mah: 4600 },
            { n: 'Magic4', mah: 4800 }
        ] },
        { b: '荣耀 HONOR', s: 'Magic3 系列', m: [
            { n: 'Magic3 Pro', mah: 4600 },
            { n: 'Magic3', mah: 4600 }
        ] },
        { b: '荣耀 HONOR', s: '荣耀 400 系列', m: [
            { n: '荣耀 400 Pro', mah: 7200 },
            { n: '荣耀 400', mah: 7200 }
        ] },
        { b: '荣耀 HONOR', s: '荣耀 300 系列', m: [
            { n: '荣耀 300 Pro', mah: 5300 },
            { n: '荣耀 300', mah: 5300 }
        ] },
        { b: '荣耀 HONOR', s: '荣耀 200 系列', m: [
            { n: '荣耀 200 Pro', mah: 5200 },
            { n: '荣耀 200', mah: 5000 }
        ] },
        { b: '荣耀 HONOR', s: '荣耀 100 系列', m: [
            { n: '荣耀 100 Pro', mah: 5000 },
            { n: '荣耀 100', mah: 5000 }
        ] },
        { b: '荣耀 HONOR', s: '荣耀 90 系列', m: [
            { n: '荣耀 90 Pro', mah: 5000 },
            { n: '荣耀 90', mah: 5000 }
        ] },
        { b: '荣耀 HONOR', s: '荣耀 80 系列', m: [
            { n: '荣耀 80', mah: 4800 }
        ] },
        { b: '荣耀 HONOR', s: '荣耀 70 系列', m: [
            { n: '荣耀 70', mah: 4800 }
        ] },
        { b: '荣耀 HONOR', s: '荣耀 60 系列', m: [
            { n: '荣耀 60', mah: 4800 }
        ] },
        { b: '荣耀 HONOR', s: '荣耀 50 系列', m: [
            { n: '荣耀 50', mah: 4300 }
        ] },
        { b: '荣耀 HONOR', s: '荣耀 X 系列', m: [
            { n: '荣耀 X60', mah: 6100 },
            { n: '荣耀 X50', mah: 5800 },
            { n: '荣耀 X40', mah: 5100 }
        ] },
        { b: '荣耀 HONOR', s: '荣耀 Power 系列', m: [
            { n: '荣耀 Power', mah: 8000 }
        ] },
        { b: '荣耀 HONOR', s: 'Magic V 折叠系列', m: [
            { n: 'Magic V3（折叠）', mah: 5150 },
            { n: 'Magic V2（折叠）', mah: 5000 }
        ] },
        { b: '荣耀 HONOR', s: 'MagicBook 系列', m: [
            { n: 'MagicBook 14 2022', wh: 75.0 },
            { n: 'MagicBook X 14', wh: 42.0 },
            { n: 'MagicBook 16 Pro', wh: 75.0 }
        ] },
        { b: '荣耀 HONOR', s: '荣耀平板系列', m: [
            { n: 'MagicPad 13', mah: 10050 },
            { n: '荣耀平板 9', mah: 8500 }
        ] },

        // ───────── OPPO / 一加 ─────────
        { b: 'OPPO / 一加', s: 'Find X8 系列', m: [
            { n: 'Find X8s+', mah: 6100 },
            { n: 'Find X8s', mah: 5700 },
            { n: 'Find X8 Pro', mah: 5910 },
            { n: 'Find X8', mah: 5630 }
        ] },
        { b: 'OPPO / 一加', s: 'Find X7 系列', m: [
            { n: 'Find X7 Ultra', mah: 5000 },
            { n: 'Find X7', mah: 5000 }
        ] },
        { b: 'OPPO / 一加', s: 'Find X6 系列', m: [
            { n: 'Find X6 Pro', mah: 5000 },
            { n: 'Find X6', mah: 4800 }
        ] },
        { b: 'OPPO / 一加', s: 'Find X5 系列', m: [
            { n: 'Find X5 Pro', mah: 5000 }
        ] },
        { b: 'OPPO / 一加', s: 'Find X3 系列', m: [
            { n: 'Find X3 Pro', mah: 4500 }
        ] },
        { b: 'OPPO / 一加', s: 'Find N 折叠系列', m: [
            { n: 'Find N5（折叠）', mah: 5600 },
            { n: 'Find N3（折叠）', mah: 4805 }
        ] },
        { b: 'OPPO / 一加', s: 'Reno14 系列', m: [
            { n: 'Reno14 Pro', mah: 6200 },
            { n: 'Reno14', mah: 6000 }
        ] },
        { b: 'OPPO / 一加', s: 'Reno13 系列', m: [
            { n: 'Reno13 Pro', mah: 5800 },
            { n: 'Reno13', mah: 5600 }
        ] },
        { b: 'OPPO / 一加', s: 'Reno12 系列', m: [
            { n: 'Reno12', mah: 5000 }
        ] },
        { b: 'OPPO / 一加', s: 'Reno11 系列', m: [
            { n: 'Reno11 Pro', mah: 4800 }
        ] },
        { b: 'OPPO / 一加', s: 'Reno10 系列', m: [
            { n: 'Reno10 Pro', mah: 4600 }
        ] },
        { b: 'OPPO / 一加', s: 'Reno9 系列', m: [
            { n: 'Reno9 Pro', mah: 4500 }
        ] },
        { b: 'OPPO / 一加', s: 'Reno8 系列', m: [
            { n: 'Reno8 Pro', mah: 4500 }
        ] },
        { b: 'OPPO / 一加', s: 'Reno7 系列', m: [
            { n: 'Reno7 Pro', mah: 4500 }
        ] },
        { b: 'OPPO / 一加', s: 'Reno6 系列', m: [
            { n: 'Reno6 Pro', mah: 4500 }
        ] },
        { b: 'OPPO / 一加', s: 'Reno5 系列', m: [
            { n: 'Reno5 Pro', mah: 4350 }
        ] },
        { b: 'OPPO / 一加', s: '一加 15 系列', m: [
            { n: '一加 15', mah: 7300 }
        ] },
        { b: 'OPPO / 一加', s: '一加 13 系列', m: [
            { n: '一加 13', mah: 6000 }
        ] },
        { b: 'OPPO / 一加', s: '一加 12 系列', m: [
            { n: '一加 12', mah: 5400 }
        ] },
        { b: 'OPPO / 一加', s: '一加 11 系列', m: [
            { n: '一加 11', mah: 5000 }
        ] },
        { b: 'OPPO / 一加', s: '一加 10 系列', m: [
            { n: '一加 10 Pro', mah: 5000 },
            { n: '一加 10T', mah: 4800 }
        ] },
        { b: 'OPPO / 一加', s: '一加 9 系列', m: [
            { n: '一加 9 Pro', mah: 4500 },
            { n: '一加 9', mah: 4500 },
            { n: '一加 9RT', mah: 4500 }
        ] },
        { b: 'OPPO / 一加', s: '一加 Ace 5 系列', m: [
            { n: '一加 Ace 5 Pro', mah: 6100 },
            { n: '一加 Ace 5', mah: 6415 }
        ] },
        { b: 'OPPO / 一加', s: '一加 Ace 3 系列', m: [
            { n: '一加 Ace 3 Pro', mah: 6100 },
            { n: '一加 Ace 3', mah: 5500 }
        ] },
        { b: 'OPPO / 一加', s: '一加 Ace 2 系列', m: [
            { n: '一加 Ace 2 Pro', mah: 5000 },
            { n: '一加 Ace 2', mah: 5000 }
        ] },
        { b: 'OPPO / 一加', s: '一加 Ace 系列', m: [
            { n: '一加 Ace Pro', mah: 4800 },
            { n: '一加 Ace', mah: 4500 }
        ] },
        { b: 'OPPO / 一加', s: 'OPPO Pad 系列', m: [
            { n: 'OPPO Pad 2', mah: 9510 },
            { n: '一加平板 Pro', mah: 9510 }
        ] },
        { b: 'OPPO / 一加', s: 'OPPO 穿戴系列', m: [
            { n: 'OPPO Enco X3（含盒）', wh: 1.6 },
            { n: 'OPPO Watch X', wh: 2.2 }
        ] },

        // ───────── vivo / iQOO ─────────
        { b: 'vivo / iQOO', s: 'X200 系列', m: [
            { n: 'X200 Pro mini', mah: 5700 },
            { n: 'X200 Pro', mah: 6000 },
            { n: 'X200', mah: 5800 }
        ] },
        { b: 'vivo / iQOO', s: 'X100 系列', m: [
            { n: 'X100s', mah: 5100 },
            { n: 'X100 Pro', mah: 5400 },
            { n: 'X100', mah: 5000 }
        ] },
        { b: 'vivo / iQOO', s: 'X90 系列', m: [
            { n: 'X90 Pro+', mah: 4700 },
            { n: 'X90 Pro', mah: 4870 },
            { n: 'X90', mah: 4810 }
        ] },
        { b: 'vivo / iQOO', s: 'X80 系列', m: [
            { n: 'X80 Pro', mah: 4700 },
            { n: 'X80', mah: 4700 }
        ] },
        { b: 'vivo / iQOO', s: 'X70 系列', m: [
            { n: 'X70 Pro', mah: 4450 },
            { n: 'X70', mah: 4400 }
        ] },
        { b: 'vivo / iQOO', s: 'X60 系列', m: [
            { n: 'X60 Pro', mah: 4350 },
            { n: 'X60', mah: 4300 }
        ] },
        { b: 'vivo / iQOO', s: 'S20 系列', m: [
            { n: 'S20 Pro', mah: 5500 },
            { n: 'S20', mah: 5000 }
        ] },
        { b: 'vivo / iQOO', s: 'S19 系列', m: [
            { n: 'S19', mah: 6000 }
        ] },
        { b: 'vivo / iQOO', s: 'S18 系列', m: [
            { n: 'S18', mah: 5000 }
        ] },
        { b: 'vivo / iQOO', s: 'S17 系列', m: [
            { n: 'S17', mah: 5000 }
        ] },
        { b: 'vivo / iQOO', s: 'S16 系列', m: [
            { n: 'S16', mah: 4600 }
        ] },
        { b: 'vivo / iQOO', s: 'S15 系列', m: [
            { n: 'S15', mah: 4500 }
        ] },
        { b: 'vivo / iQOO', s: 'S12 系列', m: [
            { n: 'S12', mah: 4200 }
        ] },
        { b: 'vivo / iQOO', s: 'X Fold 折叠系列', m: [
            { n: 'X Fold3 Pro（折叠）', mah: 5700 },
            { n: 'X Fold3（折叠）', mah: 5500 },
            { n: 'X Fold2（折叠）', mah: 4800 }
        ] },
        { b: 'vivo / iQOO', s: 'iQOO 15 系列', m: [
            { n: 'iQOO 15', mah: 7000 }
        ] },
        { b: 'vivo / iQOO', s: 'iQOO 13 系列', m: [
            { n: 'iQOO 13', mah: 6150 }
        ] },
        { b: 'vivo / iQOO', s: 'iQOO 12 系列', m: [
            { n: 'iQOO 12', mah: 5000 }
        ] },
        { b: 'vivo / iQOO', s: 'iQOO 11 系列', m: [
            { n: 'iQOO 11', mah: 5000 }
        ] },
        { b: 'vivo / iQOO', s: 'iQOO 10 系列', m: [
            { n: 'iQOO 10', mah: 4700 }
        ] },
        { b: 'vivo / iQOO', s: 'iQOO 9 系列', m: [
            { n: 'iQOO 9', mah: 4700 }
        ] },
        { b: 'vivo / iQOO', s: 'iQOO 8 系列', m: [
            { n: 'iQOO 8', mah: 4350 }
        ] },
        { b: 'vivo / iQOO', s: 'iQOO Neo11 系列', m: [
            { n: 'iQOO Neo11', mah: 7500 }
        ] },
        { b: 'vivo / iQOO', s: 'iQOO Neo10 系列', m: [
            { n: 'iQOO Neo10 Pro+', mah: 6800 },
            { n: 'iQOO Neo10 Pro', mah: 6100 },
            { n: 'iQOO Neo10', mah: 6100 }
        ] },
        { b: 'vivo / iQOO', s: 'iQOO Neo9 系列', m: [
            { n: 'iQOO Neo9S Pro', mah: 5160 },
            { n: 'iQOO Neo9', mah: 5160 }
        ] },
        { b: 'vivo / iQOO', s: 'iQOO Neo8 系列', m: [
            { n: 'iQOO Neo8', mah: 5000 }
        ] },
        { b: 'vivo / iQOO', s: 'iQOO Neo7 系列', m: [
            { n: 'iQOO Neo7', mah: 5000 }
        ] },
        { b: 'vivo / iQOO', s: 'iQOO Neo6 系列', m: [
            { n: 'iQOO Neo6', mah: 4700 }
        ] },
        { b: 'vivo / iQOO', s: 'iQOO Neo5 系列', m: [
            { n: 'iQOO Neo5', mah: 4400 }
        ] },
        { b: 'vivo / iQOO', s: 'iQOO Z10 系列', m: [
            { n: 'iQOO Z10 Turbo+', mah: 8000 },
            { n: 'iQOO Z10 Turbo Pro', mah: 7000 },
            { n: 'iQOO Z10 Turbo', mah: 7620 },
            { n: 'iQOO Z10', mah: 7300 },
            { n: 'iQOO Z10x', mah: 6500 }
        ] },
        { b: 'vivo / iQOO', s: 'iQOO Z9 系列', m: [
            { n: 'iQOO Z9 Turbo+', mah: 6400 },
            { n: 'iQOO Z9 Turbo', mah: 6000 },
            { n: 'iQOO Z9', mah: 6000 },
            { n: 'iQOO Z9x', mah: 6000 }
        ] },
        { b: 'vivo / iQOO', s: 'iQOO Z8 系列', m: [
            { n: 'iQOO Z8', mah: 5000 },
            { n: 'iQOO Z8x', mah: 5000 }
        ] },
        { b: 'vivo / iQOO', s: 'iQOO Z7 系列', m: [
            { n: 'iQOO Z7', mah: 5000 }
        ] },
        { b: 'vivo / iQOO', s: 'vivo Pad 系列', m: [
            { n: 'vivo Pad3 Pro', mah: 11500 },
            { n: 'vivo Pad3', mah: 10000 }
        ] },
        { b: 'vivo / iQOO', s: 'vivo 穿戴系列', m: [
            { n: 'vivo WATCH GT', wh: 1.9 },
            { n: 'vivo TWS 4（含盒）', wh: 1.6 }
        ] },

        // ───────── 真我 realme ─────────
        { b: '真我 realme', s: 'GT7 系列', m: [
            { n: '真我 GT7', mah: 7000 },
            { n: '真我 GT7 Pro', mah: 6500 }
        ] },
        { b: '真我 realme', s: 'GT6 系列', m: [
            { n: '真我 GT6', mah: 5800 }
        ] },
        { b: '真我 realme', s: 'GT5 系列', m: [
            { n: '真我 GT5 Pro', mah: 5400 },
            { n: '真我 GT5', mah: 5240 }
        ] },
        { b: '真我 realme', s: 'GT Neo5 系列', m: [
            { n: '真我 GT Neo5 SE', mah: 5500 },
            { n: '真我 GT Neo5', mah: 5000 }
        ] },
        { b: '真我 realme', s: 'GT Neo3 系列', m: [
            { n: '真我 GT Neo3', mah: 5000 }
        ] },
        { b: '真我 realme', s: 'GT Neo2 系列', m: [
            { n: '真我 GT Neo2', mah: 5000 }
        ] },
        { b: '真我 realme', s: 'Neo7 系列', m: [
            { n: '真我 Neo7', mah: 7000 }
        ] },

        // ───────── 红魔 / 努比亚 ─────────
        { b: '红魔 / 努比亚', s: '红魔 10 系列', m: [
            { n: '红魔 10 Pro+', mah: 7050 },
            { n: '红魔 10 Pro', mah: 7050 }
        ] },
        { b: '红魔 / 努比亚', s: '红魔 9 系列', m: [
            { n: '红魔 9 Pro+', mah: 5500 },
            { n: '红魔 9 Pro', mah: 6500 }
        ] },
        { b: '红魔 / 努比亚', s: '红魔 8 系列', m: [
            { n: '红魔 8S Pro', mah: 6500 },
            { n: '红魔 8 Pro', mah: 6000 }
        ] },
        { b: '红魔 / 努比亚', s: '红魔 7 系列', m: [
            { n: '红魔 7 Pro', mah: 5000 }
        ] },
        { b: '红魔 / 努比亚', s: '红魔 6 系列', m: [
            { n: '红魔 6S Pro', mah: 4500 },
            { n: '红魔 6 Pro', mah: 4500 }
        ] },
        { b: '红魔 / 努比亚', s: '努比亚 Z70 系列', m: [
            { n: '努比亚 Z70 Ultra', mah: 6150 }
        ] },
        { b: '红魔 / 努比亚', s: '努比亚 Z60 系列', m: [
            { n: '努比亚 Z60 Ultra', mah: 6000 }
        ] },
        { b: '红魔 / 努比亚', s: '努比亚 Z50 系列', m: [
            { n: '努比亚 Z50', mah: 5000 }
        ] },
        { b: '红魔 / 努比亚', s: '努比亚 Z40 系列', m: [
            { n: '努比亚 Z40 Pro', mah: 5000 }
        ] },

        // ───────── 魅族 ─────────
        { b: '魅族 Meizu', s: '魅族 21 系列', m: [
            { n: '魅族 21 Note', mah: 5150 },
            { n: '魅族 21 Pro', mah: 5050 },
            { n: '魅族 21', mah: 4800 }
        ] },
        { b: '魅族 Meizu', s: '魅族 20 系列', m: [
            { n: '魅族 20 Pro', mah: 5000 },
            { n: '魅族 20', mah: 4700 }
        ] },
        { b: '魅族 Meizu', s: '魅族 18 系列', m: [
            { n: '魅族 18s Pro', mah: 4500 },
            { n: '魅族 18s', mah: 4000 },
            { n: '魅族 18 Pro', mah: 4500 },
            { n: '魅族 18', mah: 4000 }
        ] },

        // ───────── 三星 ─────────
        { b: '三星 Samsung', s: 'Galaxy S25 系列', m: [
            { n: 'Galaxy S25 Ultra', mah: 5000 },
            { n: 'Galaxy S25+', mah: 4900 },
            { n: 'Galaxy S25', mah: 4000 }
        ] },
        { b: '三星 Samsung', s: 'Galaxy S24 系列', m: [
            { n: 'Galaxy S24 Ultra', mah: 5000 },
            { n: 'Galaxy S24+', mah: 4900 },
            { n: 'Galaxy S24', mah: 4000 }
        ] },
        { b: '三星 Samsung', s: 'Galaxy S23 系列', m: [
            { n: 'Galaxy S23 Ultra', mah: 5000 },
            { n: 'Galaxy S23+', mah: 4700 },
            { n: 'Galaxy S23', mah: 3900 }
        ] },
        { b: '三星 Samsung', s: 'Galaxy S22 系列', m: [
            { n: 'Galaxy S22 Ultra', mah: 5000 },
            { n: 'Galaxy S22+', mah: 4520 },
            { n: 'Galaxy S22', mah: 3700 }
        ] },
        { b: '三星 Samsung', s: 'Galaxy S21 系列', m: [
            { n: 'Galaxy S21 Ultra', mah: 5000 },
            { n: 'Galaxy S21+', mah: 4800 },
            { n: 'Galaxy S21', mah: 4000 }
        ] },
        { b: '三星 Samsung', s: 'Galaxy Z Fold 系列', m: [
            { n: 'Galaxy Z Fold6', mah: 4400 },
            { n: 'Galaxy Z Fold5', mah: 4400 },
            { n: 'Galaxy Z Fold4', mah: 4400 },
            { n: 'Galaxy Z Fold3', mah: 4400 }
        ] },
        { b: '三星 Samsung', s: 'Galaxy Z Flip 系列', m: [
            { n: 'Galaxy Z Flip6', mah: 4000 },
            { n: 'Galaxy Z Flip5', mah: 4000 },
            { n: 'Galaxy Z Flip4', mah: 3700 },
            { n: 'Galaxy Z Flip3', mah: 3300 }
        ] },
        { b: '三星 Samsung', s: 'Galaxy Tab S10 系列', m: [
            { n: 'Galaxy Tab S10 Ultra', mah: 11600 },
            { n: 'Galaxy Tab S10+', mah: 10090 }
        ] },
        { b: '三星 Samsung', s: 'Galaxy Tab S9 系列', m: [
            { n: 'Galaxy Tab S9 Ultra', mah: 11400 },
            { n: 'Galaxy Tab S9+', mah: 10090 },
            { n: 'Galaxy Tab S9', mah: 8000 },
            { n: 'Galaxy Tab S9 FE+', mah: 10090 },
            { n: 'Galaxy Tab S9 FE', mah: 8000 }
        ] },
        { b: '三星 Samsung', s: 'Galaxy Tab S8 系列', m: [
            { n: 'Galaxy Tab S8 Ultra', mah: 11200 },
            { n: 'Galaxy Tab S8+', mah: 10090 },
            { n: 'Galaxy Tab S8', mah: 8000 }
        ] },
        { b: '三星 Samsung', s: 'Galaxy A 系列', m: [
            { n: 'Galaxy A55', mah: 5000 },
            { n: 'Galaxy A54', mah: 5000 },
            { n: 'Galaxy A35', mah: 5000 }
        ] },
        { b: '三星 Samsung', s: 'Galaxy 穿戴系列', m: [
            { n: 'Galaxy Buds3 Pro（含盒）', wh: 1.9 },
            { n: 'Galaxy Buds2 Pro（含盒）', wh: 1.9 },
            { n: 'Galaxy Watch 7', wh: 1.3 }
        ] },

        // ───────── Google / 索尼 / 摩托罗拉 / Nothing ─────────
        { b: 'Google', s: 'Pixel 9 系列', m: [
            { n: 'Pixel 9 Pro XL', mah: 5060 },
            { n: 'Pixel 9 Pro', mah: 4700 },
            { n: 'Pixel 9', mah: 4700 },
            { n: 'Pixel 9a', mah: 5100 }
        ] },
        { b: 'Google', s: 'Pixel 8 系列', m: [
            { n: 'Pixel 8 Pro', mah: 5050 },
            { n: 'Pixel 8', mah: 4575 },
            { n: 'Pixel 8a', mah: 4492 }
        ] },
        { b: 'Google', s: 'Pixel 7 系列', m: [
            { n: 'Pixel 7 Pro', mah: 5000 },
            { n: 'Pixel 7', mah: 4355 },
            { n: 'Pixel 7a', mah: 4385 }
        ] },
        { b: 'Google', s: 'Pixel 6 系列', m: [
            { n: 'Pixel 6 Pro', mah: 5003 },
            { n: 'Pixel 6', mah: 4614 },
            { n: 'Pixel 6a', mah: 4410 }
        ] },
        { b: 'Google', s: 'Pixel 5 系列', m: [
            { n: 'Pixel 5a', mah: 4680 }
        ] },
        { b: '索尼 Sony', s: 'Xperia 1 系列', m: [
            { n: 'Xperia 1 V', mah: 5000 },
            { n: 'Xperia 1 IV', mah: 5000 },
            { n: 'Xperia 1 III', mah: 4500 }
        ] },
        { b: '索尼 Sony', s: 'Xperia 5 系列', m: [
            { n: 'Xperia 5 IV', mah: 5000 }
        ] },
        { b: '索尼 Sony', s: 'Xperia 10 系列', m: [
            { n: 'Xperia 10 V', mah: 5000 }
        ] },
        { b: '摩托罗拉 Motorola', s: 'moto X 系列', m: [
            { n: 'moto X50 Ultra', mah: 4500 },
            { n: 'moto X40', mah: 4600 }
        ] },
        { b: '摩托罗拉 Motorola', s: 'moto S 系列', m: [
            { n: 'moto S50', mah: 4310 }
        ] },
        { b: '摩托罗拉 Motorola', s: 'moto edge 系列', m: [
            { n: 'moto edge 40 Pro', mah: 4600 }
        ] },
        { b: 'Nothing', s: 'Nothing Phone 系列', m: [
            { n: 'Phone (2a)', mah: 5000 },
            { n: 'Phone (2)', mah: 4700 },
            { n: 'Phone (1)', mah: 4500 }
        ] },

        // ───────── 笔记本 ─────────
        { b: '联想 Lenovo', s: 'ThinkPad 系列', m: [
            { n: 'ThinkPad X1 Carbon', wh: 57.0 },
            { n: 'ThinkPad T14', wh: 52.5 }
        ] },
        { b: '联想 Lenovo', s: 'ThinkBook 系列', m: [
            { n: 'ThinkBook 14+', wh: 62.0 },
            { n: 'ThinkBook 16+', wh: 85.0 }
        ] },
        { b: '联想 Lenovo', s: '小新系列', m: [
            { n: '小新 Pro 14', wh: 75.0 },
            { n: '小新 Pro 16', wh: 75.0 },
            { n: '小新 16', wh: 60.0 },
            { n: '小新 Air 14', wh: 56.5 }
        ] },
        { b: '联想 Lenovo', s: '拯救者系列', m: [
            { n: '拯救者 Y9000P / R9000P', wh: 84.0 },
            { n: '拯救者 Y7000P', wh: 80.0 }
        ] },
        { b: '机械革命', s: '无界系列', m: [
            { n: '无界 14X', wh: 60.0 },
            { n: '无界 16 Pro', wh: 70.0 }
        ] },
        { b: '机械革命', s: '极光系列', m: [
            { n: '极光 Pro', wh: 63.0 }
        ] },
        { b: '机械革命', s: '旷世系列', m: [
            { n: '旷世 16 Super', wh: 80.0 }
        ] },
        { b: '机械革命', s: '蛟龙系列', m: [
            { n: '蛟龙 16 Pro', wh: 80.0 }
        ] },
        { b: '华硕 ASUS', s: '天选系列', m: [
            { n: '天选 5 Pro', wh: 90.0 },
            { n: '天选 4', wh: 90.0 }
        ] },
        { b: '华硕 ASUS', s: 'ROG 系列', m: [
            { n: 'ROG 幻 14', wh: 73.0 },
            { n: 'ROG 魔霸新锐', wh: 90.0 },
            { n: 'ROG 枪神 8', wh: 90.0 }
        ] },
        { b: '华硕 ASUS', s: '灵耀系列', m: [
            { n: '灵耀 14', wh: 75.0 }
        ] },
        { b: '华硕 ASUS', s: '无畏系列', m: [
            { n: '无畏 Pro 15', wh: 70.0 }
        ] },
        { b: '戴尔 Dell', s: 'XPS 系列', m: [
            { n: 'XPS 13', wh: 55.0 },
            { n: 'XPS 15', wh: 86.0 }
        ] },
        { b: '戴尔 Dell', s: '灵越系列', m: [
            { n: '灵越 14 Plus', wh: 54.0 },
            { n: '灵越 16 Plus', wh: 86.0 }
        ] },
        { b: '惠普 HP', s: '星Book 系列', m: [
            { n: '星Book Pro 14', wh: 68.0 },
            { n: '星Book Pro 16', wh: 68.0 }
        ] },
        { b: '惠普 HP', s: '暗影精灵系列', m: [
            { n: '暗影精灵 10', wh: 70.0 }
        ] },
        { b: '惠普 HP', s: '战系列', m: [
            { n: '战 66', wh: 51.0 }
        ] },
        { b: '宏碁 Acer / 微软', s: '宏碁非凡系列', m: [
            { n: '宏碁 非凡 Go 14', wh: 65.0 }
        ] },
        { b: '宏碁 Acer / 微软', s: '掠夺者系列', m: [
            { n: '宏碁 掠夺者 擎 Neo', wh: 90.0 }
        ] },
        { b: '宏碁 Acer / 微软', s: 'Surface Pro 系列', m: [
            { n: 'Surface Pro 11', wh: 48.0 },
            { n: 'Surface Pro 9', wh: 47.0 }
        ] },
        { b: '宏碁 Acer / 微软', s: 'Surface Laptop 系列', m: [
            { n: 'Surface Laptop 7', wh: 54.0 }
        ] },

        // ───────── 掌机 ─────────
        { b: '游戏掌机', s: 'Steam Deck 系列', m: [
            { n: 'Steam Deck OLED', wh: 50.0 },
            { n: 'Steam Deck LCD', wh: 40.0 }
        ] },
        { b: '游戏掌机', s: 'ROG Ally 系列', m: [
            { n: 'ROG Ally X', wh: 80.0 },
            { n: 'ROG Ally', wh: 40.0 }
        ] },
        { b: '游戏掌机', s: 'Legion Go 系列', m: [
            { n: '联想 Legion Go', wh: 49.2 }
        ] },
        { b: '游戏掌机', s: 'Switch 系列', m: [
            { n: 'Switch 2', wh: 20.0 },
            { n: 'Switch OLED', wh: 16.0 },
            { n: 'Switch 续航版', wh: 13.6 }
        ] },

        // ───────── 充电宝 / 其它 ─────────
        { b: '充电宝 / 其它', s: '充电宝系列', m: [
            { n: '充电宝 10000mAh', wh: 37.0 },
            { n: '充电宝 20000mAh', wh: 74.0 },
            { n: '充电宝 25000mAh', wh: 92.5 }
        ] },
        { b: '充电宝 / 其它', s: '通用小设备系列', m: [
            { n: '通用 TWS 耳机盒', wh: 1.5 },
            { n: '通用智能手表', wh: 1.8 },
            { n: '通用电动牙刷', wh: 2.4 },
            { n: '通用蓝牙音箱', wh: 12.0 },
            { n: '通用无人机', wh: 30.0 }
        ] }
    ];

    // Wh 归一：给了 wh 用它，给了 mah 按电压折算
    function whOf(entry, brand) {
        if (entry.wh) return entry.wh;
        var v = (brand && brand.indexOf('充电宝') >= 0) ? V_PB : V_PHONE;
        return Math.round(entry.mah * v / 100) / 10;
    }

    var Q = [];
    DB.forEach(function (grp) {
        grp.m.forEach(function (entry) {
            var wh = whOf(entry, grp.b);
            Q.push({
                brand: grp.b,
                series: grp.s,
                name: entry.n,
                mah: entry.mah || Math.round(wh * 1000 / V_PHONE),
                wh: wh,
                // 搜索用的归一化文本：小写 + 去掉空格/引号，让 "15pro" 也能命中
                key: (grp.b + ' ' + grp.s + ' ' + entry.n).toLowerCase()
                    .replace(/\s+/g, ' '),
                compact: (grp.b + grp.s + entry.n).toLowerCase()
                    .replace(/[\s"'’“”\-_()（）]/g, '')
            });
        });
    });

    function brands() {
        var seen = {}, out = [];
        DB.forEach(function (g) {
            if (!seen[g.b]) { seen[g.b] = 1; out.push(g.b); }
        });
        return out;
    }

    function series(brand) {
        return DB.filter(function (g) { return g.b === brand; })
            .map(function (g) { return g.s; });
    }

    function models(brand, s) {
        var grp = DB.filter(function (g) { return g.b === brand && g.s === s; })[0];
        if (!grp) return [];
        return grp.m.map(function (entry) {
            return {
                name: entry.n, brand: brand, series: s,
                wh: whOf(entry, brand),
                mah: entry.mah || 0
            };
        });
    }

    // 搜索：完全子串优先，其次"去掉空格/连字符后仍能命中"（"15pro" → "15 Pro"）
    function search(q, limit) {
        var raw = (q || '').trim().toLowerCase();
        if (!raw) return [];
        var compact = raw.replace(/[\s"'’“”\-_()（）]/g, '');
        var hits = [];
        Q.forEach(function (it) {
            var score = -1;
            if (it.key.indexOf(raw) >= 0) score = 0;
            else if (compact && it.compact.indexOf(compact) >= 0) score = 1;
            if (score >= 0) hits.push({ it: it, score: score, at: it.key.indexOf(raw) });
        });
        hits.sort(function (a, b) {
            if (a.score !== b.score) return a.score - b.score;
            if (a.at !== b.at) return a.at - b.at;
            return a.it.name.length - b.it.name.length;
        });
        return hits.slice(0, limit || 12).map(function (h) {
            return {
                name: h.it.name, brand: h.it.brand, series: h.it.series,
                wh: h.it.wh, mah: h.it.mah
            };
        });
    }

    global.BatteryDB = {
        brands: brands,
        series: series,
        models: models,
        search: search,
        all: Q
    };
})(window);
