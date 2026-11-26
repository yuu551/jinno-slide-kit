import Editor from './Editor.js'
    const svgEditor = new Editor(document.getElementById('container'))
    svgEditor.setConfig({
      lang: 'ja',
      noDefaultExtensions: true,
      // 形の編集に要るものだけ（開く・保存・ブラウザ保存・コネクタは読まない）
      extensions: ['ext-grid', 'ext-markers', 'ext-shapes', 'ext-polystar', 'ext-panning', 'ext-eyedropper'],
      noStorageOnLoad: true,
      forceStorage: false,
      no_save_warning: true,
      showRulers: false,
      showlayers: false,
      canvas_expansion: 1.2,
      preventAllURLConfig: true,
      initFill: { color: 'FFFFFF', opacity: 1 },
      initStroke: { color: '545B64', width: 1.6, opacity: 1 },
      text: { stroke_width: 0, font_size: 20, font_family: 'Noto Sans JP, Hiragino Sans, sans-serif' }
    })
    window.svgEditor = svgEditor
    svgEditor.init()
