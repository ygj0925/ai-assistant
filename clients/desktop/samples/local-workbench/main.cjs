function formatDuration(minutes) {
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

module.exports = { formatDuration };
