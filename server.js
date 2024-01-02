var fs          = require("fs");
var http        = require("http");
var querystring = require("querystring");
var url_parse   = require("url");
var ws          = require("ws");

console.log("Starting server...");

var port = 8080;
var host = "0.0.0.0";
var database_name = "./world.m4k";

var map;

if(!fs.existsSync(database_name)) {
	map = new Uint8Array(64 * 64 * 64);
	console.log("Creating level...")
	for (x = 0; x < 64; x++) { // default map (grass and dirt flat-land)
		for (y = 0; y < 64; y++) {
			for ( var z = 0; z < 64; z++) {
				i = z << 12 | y << 6 | x; // convert XYZ into index
				var block = 0;
				if(y === 45) block = 1;
				if(y > 45) block = 2;
				if(y == 45 && x >= 28 && x <= 34 && z >= 28 && z <= 34) block = 26;
				if(y == 40 && x >= 28 && x <= 34 && z >= 28 && z <= 34) block = 8;
				map[i] = block;
			}
		}
	}
	fs.writeFileSync(database_name, map);
} else {
	map = new Uint8Array(fs.readFileSync(database_name));
}

var static_files = {};
static_files.icon = fs.readFileSync("./favicon.png");
static_files.client = fs.readFileSync("./index.html");
static_files.m4k_js = fs.readFileSync("./m4k.js");
static_files.tmap = fs.readFileSync("./texture_map.png");

var server = http.createServer(function(req, res) {
	var url = url_parse.parse(req.url)
	var path = url.pathname
	if(path.charAt(0) == "/") path = path.substr(1);
	if(path.charAt(path.length - 1) == "/") path = path.slice(0, path.length - 1);
	
	if(path == "favicon.png" || path == "favicon.ico") {
		var img = Buffer.from(static_files.icon);

		res.writeHead(200, {
		  "Content-Type": "image/png",
		  "Content-Length": img.length
		});
		res.end(img);
	} else if(path == "") {
		var cl = Buffer.from(static_files.client);

		res.writeHead(200, {
		  "Content-Type": "text/html",
		  "Content-Length": cl.length
		});
		res.end(cl);
	} else if(path == "m4k.js") {
		var cl = Buffer.from(static_files.m4k_js);

		res.writeHead(200, {
		  "Content-Type": "text/js",
		  "Content-Length": cl.length
		});
		res.end(cl);
	} else if(path == "texture_map.png") {
		var cl = Buffer.from(static_files.tmap);

		res.writeHead(200, {
		  "Content-Type": "image/png",
		  "Content-Length": cl.length
		});
		res.end(cl);
	} else {
		res.writeHead(404);
		res.end("Not found");
	}
})

async function runserver() {
	server.listen(port, host, function() {
		var addr = server.address();
		console.log("M4k server is hosted on " + addr.address + ":" + addr.port);
		console.log("Host: " + host);
	});
	init_ws();
}
runserver();

function is_whole_number(x) {
	var isNumber = typeof x === "number" && !isNaN(x) && isFinite(x)
	if(isNumber) {
		return x === Math.trunc(x)
	}
	return false
}

function canModifyBlock(idx) {
	var x = (idx%64);
	var y = (idx%(64*64)>>6);
	var z = (idx%(64*64*64)>>12);
	if(y >= 40 && y <= 45 && x >= 28 && x <= 34 && z >= 28 && z <= 34) return false;
	return true;
}

var map_updated = false;
setInterval(function() {
	if(!map_updated) return;
	map_updated = false;
	fs.writeFileSync(database_name, map);
	console.log("updated map")
}, 5000);

var ipConnLim = {};

function init_ws() {
	var wss = new ws.Server({ server });
	wss.on("connection", function(ws, req) {
		var ipAddr = ws._socket.remoteAddress;
		if(ipAddr == "127.0.0.1") {
			ipAddr = req.headers["x-real-ip"];
			if(!ipAddr) ipAddr = Math.random().toString();
		}
		
		if(!ipConnLim[ipAddr]) {
			ipConnLim[ipAddr] = [0, 0, 0]; // connections, blocks placed in current second period, second period
		}
		var connObj = ipConnLim[ipAddr];
		
		if(connObj[0] >= 10) {
			ws.close();
			return;
		}
		
		connObj[0]++;
		
		var bseq = 0;
		
		var closed = false;
		var mapReq = false;
		ws.on("message", async function(message) {
			var data = {};
			try {
				data = JSON.parse(message);
			} catch(e) {
				console.log(encodeURIComponent(data));
				return;
			}
			if(data.type == "block_upd") {
				var index = data.index;
				if(typeof index != "number") return;
				if(isNaN(index) || !isFinite(index)) return;
				index = Math.trunc(index);
				if(index < 0 || index >= map.length) return;
				var block = data.block;
				if(typeof block != "number") return;
				if(isNaN(block) || !isFinite(block)) return;
				block = Math.trunc(block);
				if(block < 0 || block > 26) return;
				
				if(!canModifyBlock(index)) return;
				
				//if(data.seq != bseq) return;
				bseq++;
				
				var per = Math.floor(Date.now() / 1000);
				if(connObj[2] == per) {
					if(connObj[1] >= 15) return;
				} else {
					connObj[1] = 0;
				}
				connObj[2] = per;
				connObj[1]++;
				
				map[index] = block;
				map_updated = true;
				
				
				wss.clients.forEach(function(e) {
					if(e == ws) return;
					try {
						e.send(JSON.stringify({
							type: "block_changed",
							index: index,
							block: block
						}));
					} catch(e) {};
				});
			}
			if(data.type == "request_map" && !mapReq) {
				mapReq = true;
				var mapcopy = map.slice(0);
				for(var i = 0; i < 64; i++) {
					if(closed) break;
					try {
						ws.send(JSON.stringify({
							type: "map_seg",
							segment: i,
							data: Array.from(mapcopy.slice(i * 4096, i * 4096 + 4096))
						}));
					} catch(e) {
						closed = true;
					}
				}
				mapcopy = null;
			}
		});
		
		ws.on("close", function() {
			closed = true;
			connObj[0]--;
		});
		ws.on("error", function() {
			console.log("Client error");
		});
	});
}