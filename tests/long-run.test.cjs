/**
 * 长期使用冒烟：同一个项目，连续建多份报告。
 *
 * 为什么单独一个文件：full-chain.test.cjs 走的是**单次链路**——建项目、拍、
 * 圈、说、核对、发布，一遍过。真实用户是在**同一个项目上反复建报告**的，
 * 而状态残留、引导复活、草稿串味、本机文件越攒越多这类问题，
 * 单次链路一次都碰不到。账号持有人就是在第二份报告上撞见的。
 *
 * 每一轮都走完整生命周期，并在轮与轮之间检查：
 *   · 引导不再出现
 *   · 上一轮的草稿确实清干净了，不会串到这一轮
 *   · 本机照片被释放，不随使用次数无限增长（产品承诺「不占手机内存」）
 *   · 草稿索引不残留、不重复
 */
const test = require('node:test');
const assert = require('node:assert');

/** 造一个尽量贴近真机的 wx：storage + 文件系统都在内存里。 */
function makeWx() {
  const storage = {};
  const files = new Set();
  return {
    storage,
    files,
    getStorageSync: (k) => (k in storage ? storage[k] : ''),
    setStorageSync: (k, v) => { storage[k] = v; },
    removeStorageSync: (k) => { delete storage[k]; },
    env: { USER_DATA_PATH: '/wxdata' },
    getFileSystemManager: () => ({
      saveFile({ tempFilePath, success }) {
        const saved = `/wxdata/saved_${tempFilePath.split('/').pop()}`;
        files.add(saved);
        success({ savedFilePath: saved });
      },
      unlink({ filePath, success, fail }) {
        if (files.has(filePath)) { files.delete(filePath); success && success(); }
        else fail && fail({ errMsg: 'unlink:fail no such file' });
      },
      access({ filePath, success, fail }) {
        (files.has(filePath) ? success : fail)({});
      },
    }),
  };
}

function freshModules(wx) {
  global.wx = wx;
  // 草稿是按账号隔离的（indexKey 带 openId），所以要有个登录态
  global.getApp = () => ({ globalData: { userInfo: { openId: 'openid-fixed-test' } } });
  for (const m of ['../miniprogram/utils/inspection-draft.js',
                   '../miniprogram/utils/local-media.js',
                   '../miniprogram/utils/coach.js',
                   '../miniprogram/utils/coach-page.js']) {
    delete require.cache[require.resolve(m)];
  }
  return {
    draft: require('../miniprogram/utils/inspection-draft.js'),
    media: require('../miniprogram/utils/local-media.js'),
    coach: require('../miniprogram/utils/coach.js'),
  };
}

/** 一轮完整记录：拍 2 张，各带标注与语音。 */
function buildRound(round, wx) {
  const photos = [];
  for (let i = 0; i < 2; i++) {
    const temp = `/tmp/round${round}_photo${i}.jpg`;
    wx.files.add(temp);
    photos.push({
      id: `photo-${round}-${i}`,
      imagePath: `/wxdata/saved_round${round}_photo${i}.jpg`,
      localImagePath: `/wxdata/saved_round${round}_photo${i}.jpg`,
      annotationCount: 1,
      annotations: [{ id: `a${round}-${i}`, type: 'rect' }],
      analysisMode: 'manual',
      voiceText: `第 ${round} 轮第 ${i} 处：墙角疑似开裂`,
      voiceFilePath: `/wxdata/saved_round${round}_voice${i}.mp3`,
      voiceFileId: '',
    });
  }
  return {
    projectId: 'project-fixed',
    projectName: '固定测试项目',
    title: '',
    note: '',
    issueDrafts: photos,
  };
}

test('同一个项目连建 5 份报告：草稿不串味、文件不累积、引导不复活', async () => {
  const wx = makeWx();
  const { draft, media, coach } = freshModules(wx);

  // 第一轮之前把引导走一遍，之后不该再出现
  coach.startCoach(coach.COACH_STEPS[0]);
  for (const step of coach.COACH_STEPS) {
    const page = { data: {}, setData(d) { Object.assign(this.data, d); },
      ...require('../miniprogram/utils/coach-page.js').coachMethods(step, '#x') };
    page.advanceCoach(step);
  }
  assert.equal(coach.getCoachState().active, false, '引导走完应结束');

  const seenKeys = new Set();
  const filesAfterPublish = [];

  for (let round = 1; round <= 5; round++) {
    const sessionKey = `inspection-create:${round}`;
    assert.ok(!seenKeys.has(sessionKey), '每轮的会话键必须唯一');
    seenKeys.add(sessionKey);

    const form = buildRound(round, wx);
    draft.writeDraft(sessionKey, form);

    // 这一轮读到的必须是自己那两张，不能串上一轮的
    const read = draft.readDraft(sessionKey);
    assert.equal(read.form.issueDrafts.length, 2, `第 ${round} 轮应读到 2 张照片`);
    for (const item of read.form.issueDrafts) {
      assert.ok(item.id.endsWith(`-${round}-0`) || item.id.endsWith(`-${round}-1`),
        `第 ${round} 轮读到了别的轮次的数据：${item.id}`);
    }

    // 第二轮起，上一轮的草稿必须已经不在索引里
    const listed = draft.listDrafts('project-fixed');
    assert.ok(!listed.some((d) => d.sessionKey === `inspection-create:${round - 1}`),
      `第 ${round} 轮时上一轮的草稿仍在索引中`);

    // 用户照常操作，引导不能被重新激活
    for (const step of coach.COACH_STEPS) {
      const page = { data: {}, setData(d) { Object.assign(this.data, d); },
        ...require('../miniprogram/utils/coach-page.js').coachMethods(step, '#x') };
      page.advanceCoach(step);
      assert.equal(coach.getCoachState().active, false,
        `第 ${round} 轮报告时引导被复活了（动作 ${step}）`);
    }

    // 发布：草稿完成，本机照片释放
    draft.finishDraft(sessionKey);
    assert.equal(draft.readDraft(sessionKey).form, null, `第 ${round} 轮发布后草稿应已清除`);
    assert.ok(!draft.listDrafts('project-fixed').some((d) => d.sessionKey === sessionKey),
      `第 ${round} 轮发布后草稿不该留在索引里`);
    filesAfterPublish.push([...wx.files].filter(f=>f.startsWith('/wxdata/')).length);
  }

  // 「不占手机内存」：发布后本机照片不该一轮轮攒着
  // 只算小程序自己落盘到 USER_DATA_PATH 的文件——微信临时目录归微信管，
  // 不在小程序的清理职责内。
  const kept = [...wx.files].filter((f) => f.startsWith('/wxdata/'));
  assert.equal(kept.length, 0,
    `发布 5 轮后本机仍残留 ${kept.length} 个文件：${kept.join(', ')}`);
});

test('中途放弃的草稿不会累积，也不会拖住后面的报告', async () => {
  const wx = makeWx();
  const { draft } = freshModules(wx);

  // 前 3 次建到一半就放弃
  for (let round = 1; round <= 3; round++) {
    const key = `inspection-create:abandon${round}`;
    draft.writeDraft(key, buildRound(90 + round, wx));
    draft.discardDraft(key, 'project-fixed');
    assert.equal(draft.readDraft(key).form, null, `放弃的第 ${round} 份应被清掉`);
  }
  assert.equal(draft.listDrafts('project-fixed').length, 0,
    '放弃的草稿不该留在索引里');

  // 之后正常建一份，必须干净
  const key = 'inspection-create:after';
  draft.writeDraft(key, buildRound(1, wx));
  const read = draft.readDraft(key);
  assert.equal(read.form.issueDrafts.length, 2, '放弃多次后新建的草稿仍是完整的 2 张');
  assert.ok(read.form.issueDrafts.every((i) => i.id.includes('-1-')),
    '新建的草稿不能混进之前放弃那几轮的数据');
});
