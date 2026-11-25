# react-force-graph 交互细节探索

> 版本：v1.0 · 状态：实现参考（2026-11-25）  
> 项目：StoryForgeAI  
> 关联：[知识图谱可视化方案探索](./知识图谱可视化方案探索.md)、[角色关系图谱算法探讨](./角色关系图谱算法探讨.md)、[角色关系图谱实时更新策略](./角色关系图谱实时更新策略.md)  
> 说明：针对 `react-force-graph-2d`（MVP 首选）的指针交互、相机、拖拽固定、自定义绘制与常见坑，便于角色版图 / 知识库局部图落地。

---

## 一、包与模式

| 包名 | 用途 |
|------|------|
| `react-force-graph-2d` | **推荐 MVP**：Canvas 2D |
| `react-force-graph-3d` | WebGL 3D（写作场景非优先） |
| `react-force-graph` | 聚合导出，按需引用 2d |

数据约定：

```ts
graphData: {
  nodes: [{ id: string, name?: string, x?: number, y?: number, fx?: number, fy?: number, ... }],
  links: [{ source: string | Node, target: string | Node, ... }]
}
```

`source`/`target` 可为 id 字符串；引擎会解析为节点引用。

---

## 二、交互相关 Props（2D）

### 2.1 指针与点击

| Prop | 签名 / 类型 | 说明 |
|------|-------------|------|
| `onNodeClick` | `(node, event) => void` | 左键点击节点 → 打开档案/详情 |
| `onNodeRightClick` | `(node, event) => void` | 右键 → 上下文菜单 |
| `onNodeHover` | `(node \| null, prevNode \| null) => void` | 悬停进入/离开；离开时 node 为 null |
| `onLinkClick` | `(link, event) => void` | 点击边 |
| `onLinkHover` | `(link \| null, prevLink \| null) => void` | 悬停边 |
| `onBackgroundClick` | `(event) => void` | 点空白 → 取消选中 |
| `onBackgroundRightClick` | `(event) => void` | 空白右键 |
| `linkHoverPrecision` | number | 边命中灵敏度 |
| `showPointerCursor` | bool \| fn | 是否手型光标 |

注意：`onNodeHover` 在点击前也可能因指针仍在节点上而触发，属预期行为，不要当成 click。

### 2.2 拖拽

| Prop | 说明 |
|------|------|
| `enableNodeDrag` | 默认 true；关闭则不可拖 |
| `enablePointerInteraction` | 默认 true；关闭则无 hover/click/tooltip，性能更好 |
| `onNodeDrag` | `(node, { x, y }) => void` 拖拽中 |
| `onNodeDragEnd` | `(node, { x, y }) => void` 松手 |

拖拽会 **reheat** 仿真，其他节点会跟着动。

**固定位置（版图稳定关键）**：

```ts
// 拖拽结束锁定
onNodeDragEnd={(node) => {
  node.fx = node.x;
  node.fy = node.y;
  persistPosition(node.id, node.x, node.y); // 写入本地/服务端缓存
}}

// 需要解除固定（「重新整理布局」）
node.fx = undefined;
node.fy = undefined;
fgRef.current.d3ReheatSimulation();
```

Ego 中心节点：一开始就设 `fx/fy` 钉在画布逻辑中心附近。

### 2.3 缩放与平移

| Prop / 方法 | 说明 |
|-------------|------|
| `enableZoomInteraction` | 滚轮缩放 |
| `enablePanInteraction` | 拖动画布 |
| `onZoom` | `({ k, x, y }) => void` 用户或编程缩放都会触发 |
| **方法** `zoom(scale, ms?)` | 设置缩放级别 |
| **方法** `centerAt(x, y, ms?)` | 平移中心 |
| **方法** `zoomToFit(ms?, padding?, nodeFilter?)` | 适配全部（或过滤后）节点 |

`zoomToFit` 只应在 **首次布局完成** 或 **显式「适应画布」** 时调用，不要绑在每次 `onEngineStop` 上，否则用户拖完节点会再次被拉回全景。

推荐模式：

```ts
const fitOnce = useRef(true);
onEngineStop={() => {
  if (fitOnce.current) {
    fgRef.current?.zoomToFit(400, 40);
    fitOnce.current = false;
  }
}}
// graphData 整体换集时：fitOnce.current = true
```

### 2.4 开关与性能

| Prop | 默认 | 建议 |
|------|------|------|
| `enablePointerInteraction` | true | 节点很多且只浏览时可 false |
| `enableNodeDrag` | true | 只读演示可 false |
| `cooldownTicks` / `cooldownTime` | — | 控制仿真何时停止 |
| `warmupTicks` | 0 | 首屏可设 50–250 再画，布局更稳 |

大图可关 pointer interaction 换帧率；角色版图（<150）保持全开即可。

---

## 三、自定义绘制与命中区域

### 3.1 `nodeCanvasObject`

```ts
nodeCanvasObject={(node, ctx, globalScale) => {
  const label = node.name || node.id;
  const fontSize = 12 / globalScale;
  ctx.font = `${fontSize}px Sans-Serif`;
  // 圆点
  ctx.beginPath();
  ctx.arc(node.x, node.y, 5, 0, 2 * Math.PI);
  ctx.fillStyle = node.color || '#69b3a2';
  ctx.fill();
  // 文字（放大时再画，减少噪点）
  if (globalScale > 0.8) {
    ctx.fillStyle = '#eee';
    ctx.fillText(label, node.x + 6, node.y + 3);
  }
}}
```

`nodeCanvasObjectMode`：`'replace'` 完全自定义；默认在原有圆上扩展需查文档模式。

### 3.2 `nodePointerAreaPaint`（自定义形状时必看）

命中检测用离屏色块，**不是**可见绘制：

```ts
nodePointerAreaPaint={(node, color, ctx) => {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(node.x, node.y, 8, 0, 2 * Math.PI); // 比视觉圆略大更好点
  ctx.fill();
}}
```

若只改了 `nodeCanvasObject` 却点不中，多半是 pointer area 仍按默认圆、与视觉不一致。

### 3.3 边

| Prop | 用途 |
|------|------|
| `linkColor` / `linkWidth` | 按 relationType 着色、加粗 |
| `linkDirectionalArrowLength` | 有向边箭头（师徒） |
| `linkDirectionalParticles` | 流动粒子（慎用，易花） |
| `linkCanvasObject` | 自定义边与边上文字 |
| `linkLabel` | 默认 tooltip 字符串 |

---

## 四、力导向引擎 API（ref）

```ts
const fgRef = useRef();

useEffect(() => {
  const fg = fgRef.current;
  if (!fg) return;
  fg.d3Force('charge')?.strength(-120);
  fg.d3Force('link')?.distance(60);
  fg.d3Force('center')?.strength(0.05);
}, [graphData]);
```

| 方法 | 作用 |
|------|------|
| `d3Force(name)` / `d3Force(name, fn)` | 读/写力 |
| `d3ReheatSimulation()` | 重新加热布局 |
| `refresh()` | 重绘 |
| `zoomToFit` / `zoom` / `centerAt` | 相机 |
| `getGraphBbox(filter?)` | 包围盒 |

SSR/Next：动态 `import` 且 `ssr: false`；`useEffect` 里再调 `d3Force`，避免 ref 为空。

---

## 五、高亮邻居（产品常用模式）

库不内置「选中子图」，需自管状态：

```ts
const [hoverId, setHoverId] = useState(null);
const highlightNodes = useMemo(() => {
  if (!hoverId) return new Set();
  const set = new Set([hoverId]);
  links.forEach(l => {
    const s = l.source.id ?? l.source;
    const t = l.target.id ?? l.target;
    if (s === hoverId) set.add(t);
    if (t === hoverId) set.add(s);
  });
  return set;
}, [hoverId, links]);

// nodeCanvasObject / linkColor 里根据 highlightNodes 降透明或加粗
onNodeHover={(n) => setHoverId(n ? n.id : null)}
```

点击选中与 hover 可共用一套 Set，或分 `selectedId` / `hoverId`。

---

## 六、与 StoryForgeAI 场景的映射

| 产品交互 | react-force-graph 手段 |
|----------|----------------------|
| 点击角色打开档案 | `onNodeClick` → 路由/抽屉 |
| 悬停预览 identity | `onNodeHover` + 外部 Tooltip（或 `nodeLabel`） |
| 拖拽后记住位置 | `onNodeDragEnd` 写 `fx/fy` + persist |
| 适应画布 | 首次 `onEngineStop` → `zoomToFit`（一次性 flag） |
| 以选中为中心 | 过滤 graphData 为 ego 子图，或 `centerAt` + 提高中心 charge |
| 关系类型色 | `linkColor={l => typeColor[l.relationType]}` |
| 师徒方向 | `linkDirectionalArrowLength={l => l.relationType==='mentor' ? 4 : 0}` |
| 取消选中 | `onBackgroundClick` |
| 只读演示 | `enableNodeDrag={false}` |
| 性能模式 | `enablePointerInteraction={false}`（仅当必要） |

---

## 七、常见坑

| 问题 | 原因与处理 |
|------|------------|
| 每次拖完整图又 zoomToFit | `onEngineStop` 无条件 fit → 加 once 标志 |
| 自定义节点点不中 | 补 `nodePointerAreaPaint` |
| `d3Force is not a function` | ref 未就绪 / SSR；`useEffect` + 判空 |
| 换 graphData 后无法拖拽 | 与 fit/坐标重入有关；避免在拖拽流程中整表替换未保持 id |
| hover 与 click 都触发逻辑 | 分离 handler；click 不要依赖 hover 的瞬时状态 |
| 文字发虚或过大 | 用 `globalScale` 缩放 fontSize：`12/globalScale` |
| 双击与拖拽冲突 | 库偏拖拽；双击可用时间阈值自管 |

---

## 八、最小接入示意（角色版图）

```tsx
import { useRef, useCallback, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';

function CharacterGraph({ graphData, onSelect }) {
  const fgRef = useRef();
  const fitOnce = useRef(true);
  const [hover, setHover] = useState(null);

  return (
    <ForceGraph2D
      ref={fgRef}
      graphData={graphData}
      nodeId="id"
      nodeLabel={(n) => `${n.name}\n${n.identity ?? ''}`}
      linkColor={(l) => RELATION_COLORS[l.relationType] ?? '#666'}
      linkDirectionalArrowLength={(l) => (l.relationType === 'mentor' ? 5 : 0)}
      linkWidth={(l) => (l.relationType === 'enemy' ? 1.5 : 1)}
      enableNodeDrag
      onNodeClick={(n) => onSelect?.(n)}
      onNodeHover={(n) => setHover(n?.id ?? null)}
      onNodeDragEnd={(n) => {
        n.fx = n.x;
        n.fy = n.y;
      }}
      onBackgroundClick={() => onSelect?.(null)}
      cooldownTicks={80}
      onEngineStop={() => {
        if (fitOnce.current) {
          fgRef.current?.zoomToFit(300, 50);
          fitOnce.current = false;
        }
      }}
    />
  );
}
```

---

## 九、结论

1. **交互能力完整**：click/hover/drag/zoom/pan/background 均有回调，足够角色版图与局部知识图。  
2. **稳定布局靠 `fx/fy` + 一次性 `zoomToFit`**，与实时更新策略一致。  
3. **自定义外观必须同时考虑 `nodeCanvasObject` 与 `nodePointerAreaPaint`**。  
4. **高亮、过滤、Ego 是产品状态**，不是库内置，需在 React 层算子图再喂 `graphData`。  
5. MVP 用 **2D + 默认 pointer/drag 开启**；节点上千再考虑关 interaction 或换 reagraph。

---

## 十、修订记录

| 版本 | 日期 | 变更 |
|------|------|------|
| v1.0 | 2026-11-25 | 初版：交互 props、相机、固定点、自定义绘制、坑与示例 |

---

*API 以 [vasturiano/react-force-graph](https://github.com/vasturiano/react-force-graph) README 为准；升级大版本时核对 `ForceGraphMethods` 类型定义。*
