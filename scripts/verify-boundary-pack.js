'use strict';
// 分块效果示范集 · 重建核验（CLI 辅助；主入口是图形面板，见 README）。
//
//   node scripts/verify-boundary-pack.js [demo/boundary-pack]
//
// 从入库的分块输出重建大图，与完整参考逐像素比较（拼接差值），并核验：
//   - 有效区恰好铺满声明区域（无缺口、无重叠）
//   - 声明的邻域与当前内核的滤镜支撑反推一致
//   - 用当前内核重渲染每块，与入库字节完全一致
// 任一不满足即非零退出。

const path = require('path');
const { verifyBoundaryPack } = require('../src/kernel/boundary-pack');

async function main() {
  const dir = process.argv[2] || path.join(__dirname, '..', 'demo', 'boundary-pack');
  const report = await verifyBoundaryPack(dir);
  const m = report.manifest;

  console.log(`# 示范集重建核验  ${m.pack}  (${dir})`);
  console.log(`  来源: 场景 ${m.source.scene}  画幅 ${m.source.width}×${m.source.height}  种子 ${m.source.seed}  内核 ${m.generator.kernel}`);
  console.log(`  滤镜: ${m.filters.map(f => f.type + '(' + Object.entries(f).filter(([k]) => k !== 'type').map(([k, v]) => k + '=' + v).join(',') + ')').join(' → ')}`);
  console.log(`  有效区: ${m.validRegion.x0},${m.validRegion.y0} .. ${m.validRegion.x1},${m.validRegion.y1}  声明邻域 ≤${m.neighborhood.maxHalo}px`);
  console.log(`  完整参考: ${m.reference.file}  与当前内核整幅渲染差 max=${report.reference.diff.maxDiff}`);
  for (const s of report.sets) {
    console.log(
      `  [${s.dir}] ${String(s.tiles).padStart(3)} 块  邻域 ${String(s.maxHalo).padStart(3)}px  ` +
      `拼接差值 max=${s.stitch.maxDiff} mean=${s.stitch.meanDiff}  边界带 max=${s.boundary.maxDiff}  ` +
      `有效区 ${s.validRegion.ok ? '精确覆盖' : `缺${s.validRegion.uncovered}/重${s.validRegion.overlapped}`}  ` +
      `重渲染 ${s.rerenderIdentical ? '逐字节一致' : '不一致'}`,
    );
  }
  console.log(`  邻域声明与内核一致: ${report.haloConsistent ? '是' : '否'}`);
  if (report.ok) {
    console.log('  结论: 通过 —— 重建结果符合约定');
    return;
  }
  console.log('  结论: 失败');
  for (const p of report.problems) console.log('    - ' + p);
  process.exit(1);
}

main().catch(err => { console.error(err.message || err); process.exit(1); });
