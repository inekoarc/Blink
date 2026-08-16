/**
 * 角色头像「手动覆盖」表（可选）。
 *
 * 绝大多数头像走约定式本地文件：只要把图片命名为「角色名.png」放进 public/avatars/，
 * 前端 /api/avatars 会自动发现并显示，无需在此登记（详见 app.js 的 avatarFor）。
 *
 * 本表只在一种情况下使用：你想给某个角色指定一张非约定路径的图片
 * （例如外部 HTTPS URL，或本站其他位置的图片）。键必须与 hostids.js 的
 * CHARACTER_POOL 中的角色名完全一致。
 *
 * 注意：此前原神头像依赖外部 CDN（genshinbuilds.aipurrjects.com），已在本地
 * public/avatars/ 自包含化，不再需要外链，故此处默认为空。
 */
const AVATAR_OVERRIDE = {
  // 示例（取消注释即可生效）：
  // '钟离': 'https://example.com/zhongli.png',
};
