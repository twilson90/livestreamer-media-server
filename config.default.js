module.exports = {
	"nms.autostart": true,
	"nms.name": "Local Media Server",
	"nms.description": "Handles network delivery of media streams and serves them publicly.",
	"nms.rtmp_port": 1935,
	"nms.media_expire_time": 24 * 60 * 60,
	"nms.media_cleanup_interval": 1 * 60 * 60,
	"nms.hls_list_size": 10,
	"nms.hls_max_duration": 2 * 60 * 60, // 2 hrs
	"nms.hls_segment_duration": 2.0,
	"nms.keyframe_interval": 2.0,
	"nms.use_hardware": false,
	"nms.use_hevc": false
}