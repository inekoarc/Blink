/**
 * 百度贴吧经典表情包（本地化自 tb2.bdstatic.com/tb/editor/images/face/i_fXX.png）。
 * 分类组织：表情（人物表情 i_f01~i_f30）/ 物品（符号与物件 i_f31~i_f50）。
 *
 * 约定：
 *  - 每个表情以「[表情名]」形式作为文本 token 插入输入框，随消息一起发送。
 *  - app.js 渲染消息时，将文本中的 [表情名] 解析为 <img class="emoji"> 内联显示。
 *  - EMOJI_MAP 提供 表情名 -> 本地文件名 的查找表，用于渲染与匹配。
 */
window.TIEBA_EMOJIS = {
  // 常用：把贴吧最经典的表情放在第一屏，省去翻找
  '常用': [
    { name: '滑稽', file: 'i_f25.png' },
    { name: '汗', file: 'i_f08.png' },
    { name: '黑线', file: 'i_f10.png' },
    { name: '阴险', file: 'i_f16.png' },
    { name: '委屈', file: 'i_f19.png' },
    { name: '狂汗', file: 'i_f27.png' },
    { name: '泪', file: 'i_f09.png' },
    { name: '怒', file: 'i_f06.png' },
    { name: '开心', file: 'i_f07.png' },
    { name: '鄙视', file: 'i_f11.png' },
    { name: '咦', file: 'i_f18.png' },
    { name: '笑眼', file: 'i_f22.png' },
    { name: '冷', file: 'i_f23.png' },
    { name: '太开心', file: 'i_f24.png' },
    { name: '勉强', file: 'i_f26.png' },
    { name: '乖', file: 'i_f28.png' },
    { name: '惊哭', file: 'i_f30.png' },
    { name: '爱心', file: 'i_f34.png' },
    { name: '心碎', file: 'i_f35.png' },
    { name: '玫瑰', file: 'i_f36.png' },
    { name: '礼物', file: 'i_f37.png' },
    { name: '胜利', file: 'i_f47.png' },
    { name: '大拇指', file: 'i_f48.png' },
    { name: 'OK', file: 'i_f50.png' },
  ],
  '表情': [
    { name: '呵呵', file: 'i_f01.png' },
    { name: '哈哈', file: 'i_f02.png' },
    { name: '吐舌', file: 'i_f03.png' },
    { name: '啊', file: 'i_f04.png' },
    { name: '酷', file: 'i_f05.png' },
    { name: '怒', file: 'i_f06.png' },
    { name: '开心', file: 'i_f07.png' },
    { name: '汗', file: 'i_f08.png' },
    { name: '泪', file: 'i_f09.png' },
    { name: '黑线', file: 'i_f10.png' },
    { name: '鄙视', file: 'i_f11.png' },
    { name: '不高兴', file: 'i_f12.png' },
    { name: '真棒', file: 'i_f13.png' },
    { name: '钱', file: 'i_f14.png' },
    { name: '疑问', file: 'i_f15.png' },
    { name: '阴险', file: 'i_f16.png' },
    { name: '吐', file: 'i_f17.png' },
    { name: '咦', file: 'i_f18.png' },
    { name: '委屈', file: 'i_f19.png' },
    { name: '花心', file: 'i_f20.png' },
    { name: '呼~', file: 'i_f21.png' },
    { name: '笑眼', file: 'i_f22.png' },
    { name: '冷', file: 'i_f23.png' },
    { name: '太开心', file: 'i_f24.png' },
    { name: '滑稽', file: 'i_f25.png' },
    { name: '勉强', file: 'i_f26.png' },
    { name: '狂汗', file: 'i_f27.png' },
    { name: '乖', file: 'i_f28.png' },
    { name: '睡觉', file: 'i_f29.png' },
    { name: '惊哭', file: 'i_f30.png' },
  ],
  '物品': [
    { name: '升起', file: 'i_f31.png' },
    { name: '惊讶', file: 'i_f32.png' },
    { name: '喷', file: 'i_f33.png' },
    { name: '爱心', file: 'i_f34.png' },
    { name: '心碎', file: 'i_f35.png' },
    { name: '玫瑰', file: 'i_f36.png' },
    { name: '礼物', file: 'i_f37.png' },
    { name: '彩虹', file: 'i_f38.png' },
    { name: '星星月亮', file: 'i_f39.png' },
    { name: '太阳', file: 'i_f40.png' },
    { name: '钱币', file: 'i_f41.png' },
    { name: '灯泡', file: 'i_f42.png' },
    { name: '茶杯', file: 'i_f43.png' },
    { name: '蛋糕', file: 'i_f44.png' },
    { name: '音乐', file: 'i_f45.png' },
    { name: 'haha', file: 'i_f46.png' },
    { name: '胜利', file: 'i_f47.png' },
    { name: '大拇指', file: 'i_f48.png' },
    { name: '弱', file: 'i_f49.png' },
    { name: 'OK', file: 'i_f50.png' },
  ],
};

// 表情名 -> 本地文件名 查找表（供消息渲染与输入匹配）
window.EMOJI_MAP = {};
Object.keys(window.TIEBA_EMOJIS).forEach((cat) => {
  window.TIEBA_EMOJIS[cat].forEach((e) => {
    window.EMOJI_MAP[e.name] = e.file;
  });
});
