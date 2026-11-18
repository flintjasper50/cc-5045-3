'use strict';
// 边界素材制作（CLI 辅助；主入口是图形面板，见 README）。
//
//   node scripts/make-boundary-pack.js [--out demo/boundary-pack]
//
// 生成示范集：manifest.json（来源与参数、有效区、邻域）、reference.png
// （完整参考）、tiles-<尺寸>/（分块输出 + plan.json）。制作完成后立即自检，
// 自检不过则整批作废，不会留下遮错的示范集。

const path = require('path');
const { buildBoundaryPack, PACK_SPEC, specAvoidsDefaults } = require('../src/kernel/boundary-pack');

async function main() {
  const outIdx = process.argv.indexOf('--out');
  const out = outIdx >= 0 ? process.argv[outIdx + 1] : path.join(__dirname, '..', 'demo', 'boundary-pack');

  const defaultIssues = specAvoidsDefaults(PACK_SPEC);
  if (defaultIssues.length) {
    console.error('规范仍以默认值遮错，拒绝制作:');
    for (const i of defaultIssues) console.error('  - ' + i);
    process.exit(2);
  }

  console.log(`# 边界素材制作  ${PACK_SPEC.pack}`);
  console.log(`  来源: 场景 ${PACK_SPEC.scene}  画幅 ${PACK_SPEC.width}×${PACK_SPEC.height}  种子 ${PACK_SPEC.seed}`);
  console.log(`  滤镜: ${PACK_SPEC.filters.map(f => f.type + '(' + Object.entries(f).filter(([k]) => k !== 'type').map(([k, v]) => k + '=' + v).join(',') + ')').join(' → ')}`);
  console.log(`  分块尺寸: ${PACK_SPEC.tileSizes.join(' / ')}  （均不整除画幅，非 2 的幂）`);
  const t0 = Date.now();
  const { manifest, report } = await buildBoundaryPack(out);
  console.log(`  有效区: ${manifest.validRegion.x0},${manifest.validRegion.y0} .. ${manifest.validRegion.x1},${manifest.validRegion.y1}`);
  console.log(`  邻域: 最大 ${manifest.neighborhood.maxHalo}px  逐滤镜支撑 ${manifest.neighborhood.perFilter.map(f => f.type + '=' + f.support).join(', ')}`);
  for (const s of report.sets) {
    console.log(`  [${s.dir}] ${s.tiles} 块  邻域 ${s.maxHalo}px  拼接差值 max=${s.stitch.maxDiff}  边界带 max=${s.boundary.maxDiff}  有效区覆盖 ${s.validRegion.ok ? '完整' : '残缺'}  重渲染 ${s.rerenderIdentical ? '一致' : '不一致'}`);
  }
  console.log(`  自检: ${report.ok ? '通过' : '失败'}  用时 ${Date.now() - t0}ms`);
  console.log(`  输出: ${out}`);
  if (!report.ok) process.exit(1);
}

main().catch(err => { console.error(err.message || err); process.exit(1); });
