(function() {
  var style = getComputedStyle(document.documentElement);
  var accent = style.getPropertyValue('--accent').trim();
  var accent2 = style.getPropertyValue('--accent2').trim();
  var ink = style.getPropertyValue('--ink').trim();
  var muted = style.getPropertyValue('--muted').trim();
  var rule = style.getPropertyValue('--rule').trim();
  var bg2 = style.getPropertyValue('--bg2').trim();
  var success = style.getPropertyValue('--success').trim();
  var warning = style.getPropertyValue('--warning').trim();

  // --- Chart: 热点话题互动量 ---
  var chartLikes = echarts.init(document.getElementById('chart-likes'), null, { renderer: 'svg' });
  chartLikes.setOption({
    animation: false,
    tooltip: {
      trigger: 'axis',
      appendToBody: true,
      axisPointer: { type: 'shadow' },
      backgroundColor: bg2,
      borderColor: rule,
      textStyle: { color: ink, fontSize: 13 }
    },
    grid: { left: '3%', right: '15%', top: '3%', bottom: '3%', containLabel: true },
    xAxis: {
      type: 'value',
      name: '点赞数',
      nameTextStyle: { color: muted, fontSize: 12 },
      axisLabel: { color: muted, fontSize: 11 },
      axisLine: { lineStyle: { color: rule } },
      splitLine: { lineStyle: { color: rule } }
    },
    yAxis: {
      type: 'category',
      data: [
        '移民火星',
        'EB1排期预测',
        '葡萄牙移民',
        'EB5绿卡',
        '医生移民',
        '中国人去哪',
        '美国面签暂停',
        '移民风向变了',
        '江苏移民潮',
        '新西兰PR'
      ],
      axisLabel: { color: ink, fontSize: 12 },
      axisLine: { lineStyle: { color: rule } },
      axisTick: { show: false }
    },
    series: [{
      type: 'bar',
      data: [
        { value: 447, itemStyle: { color: muted } },
        { value: 4, itemStyle: { color: muted } },
        { value: 0, itemStyle: { color: muted } },
        { value: 303, itemStyle: { color: accent2 } },
        { value: 535, itemStyle: { color: accent2 } },
        { value: 1231, itemStyle: { color: accent2 } },
        { value: 3535, itemStyle: { color: warning } },
        { value: 101438, itemStyle: { color: accent } },
        { value: 21484, itemStyle: { color: accent } },
        { value: 7379, itemStyle: { color: success } }
      ],
      barMaxWidth: 28,
      label: {
        show: true,
        position: 'right',
        color: muted,
        fontSize: 11,
        formatter: function(p) {
          if (p.value >= 10000) return (p.value / 10000).toFixed(1) + '万';
          return p.value > 0 ? p.value.toString() : '';
        }
      }
    }]
  });

  window.addEventListener('resize', function() { chartLikes.resize(); });
})();