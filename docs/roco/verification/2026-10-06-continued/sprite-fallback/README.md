# 同物种捕获立绘回退：本地候选，待根复核

基线20cb334635d22ed2514cfa81f99f9c816378babb。生产只改src/server/index.js捕获图选择段：删除3行wanted/fallback/rel，加入2行存在性候选搜索。官方捕获图优先顺序不变；battle请求按battle→thumb→original，普通请求按thumb→battle→original，full=1仍只尝试original。不改物种ID、显式key及策展兜底，不借其它精灵素材。图片未修改/删除/下载/复制，未修改其它schema/client/runtime/STATE/model或既有服务，未执行git写操作。

`node --test tests/sprite-capture-fallback.test.js`：before.tap exit1（3失败/1通过）；after.tap exit0（4通过）。测试执行真实route的选择源码块，小文件系统桩覆盖大小图互相回退、都有/都缺、原件回退和explicit full；不复制生产算法。

真实HTTP命令：`node docs/roco/verification/2026-10-06-continued/sprite-fallback/http-probe.mjs http-before.json`（基线选择段），以及候选同命令换http-after.json。各exit0。短暂127.0.0.1随机端口server在finally关闭；不操作8898/8765，fetchImpl/localModelFactory拒绝云或神经模型，externalCalls=0。为取正确参数的基线对照，仅临时恢复原选择段并立即重新应用同一候选；最终源码是候选。

实际请求GET /api/roco/sprite?id=pet_000001&size=battle：喵喵Git已跟踪thumb存在、被ignore的battle/original缺失；before404→after200，Content-Type=image/png，Source=capture-2026-09-27，Variant=thumb。响应SHA256与现有thumb完全相同：bf91bd4442bf7f9b87da22a9512836f52d85657a0289e3157d0456b0c7330036。http-before.json/http-after.json保留路径存在性、状态、headers与实际body SHA。

最初探针错写pet_id=；http-invalid-query-before.json/http-invalid-query-after.json原样保留。这两条404是探针参数错误，**不算产品红或修复结果**。源码真实读取id=，已纠正探针并重新采基线/候选HTTP。根另有旧8898真实id=三条404记录，不与这里计数合并。

src/server/index.js定向diffcheck通过；未跑全库。真实图像UI由根独立复核，此处只有真实HTTP/字节与选择合同证据。下一步仅根审核与整合。
