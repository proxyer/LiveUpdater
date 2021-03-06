var express = require('express'),
    path = require('path'),
    favicon = require('serve-favicon'),
    logger = require('morgan'),
    cookieParser = require('cookie-parser'),
    fs = require('fs'),
    net = global.net = require('net'),
    cronJob = require('cron').CronJob,
    csv = require('csv'),
    winston = global.winston = require('winston'),
    exec = require('child_process').exec,
    bodyParser = require('body-parser'),
    routes = require('./routes/index'),
    users = require('./routes/user');

var app = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

// app.use(favicon(__dirname + '/public/img/favicon.ico'));
app.use(logger('dev'));
app.use(bodyParser.json({limit: '50mb'}));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', routes);
app.use('/users', users);

/// catch 404 and forward to error handler
app.use(function(req, res, next) {
    var err = new Error('Not Found');
    err.status = 404;
    next(err);
});

// read haproxy config file
var haproxyCfgDir = '/etc/haproxy/',
    haproxyCfgPath = haproxyCfgDir+'haproxy.cfg',
    socketPath = global.socketPath = '/tmp/haproxy',
    pidPath = global.pidPath = '/var/run/haproxy.pid',
    readCfgData = null,
    servers = global.servers = [],
    haproxyStat = global.haproxyStat = [];

fs.readFile(haproxyCfgPath, 'utf8', function (err, data) {
    if (err) {
        throw err;
    }

    var socketPathRegex = '/stats\s+socket \s*([^\s]*)/';

    var index = 0;
    var server = null;

    readCfgData = data;

    var lines = data.split('\n');
    for(var i=0; i<lines.length; i++) {
        var line = lines[i];

        // socket directory
        if(res=line.match(/stats\s+socket \s*([^\s]*)/)) {
            socketPath = res[1];
            // console.log('socket dir: '+res[1]);
        }
        // pidfile directory
        else if(res=line.match(/pidfile \s*([^\s]*)/)) {
            pidPath = res[1];
            // console.log('pidfile dir: '+res[0]);
        }
        // global
        else if(res=line.match(/listen *([^\s]*) *([\w\.]*):(\d+)/)) {
            if (server != null) {
                servers.push(server);
            }
            server = {
                backend: {},
                frontend: []
            };

            server.backend = {
                name: res[1],
                ip: res[2],
                port: res[3]
            };
            // console.log('backend: '+res[1]);
        }
        // server
        else if(res=line.match(/server *([^\s]*) *([\w\.]*):(\d+)/)) {
            var serverData = {
                name: res[1],
                ip: res[2],
                port: res[3]
            };
            server.frontend.push(serverData);
            // console.log('frontend: '+res[1]);
        }
    }

    if (server != null) {
        servers.push(server);
    }

});

var monitorServer = null;

// polling work
var job = new cronJob({
    cronTime: '* * * * * *',
    onTick: function () {
        var client = net.createConnection(socketPath);

        client.on('connect', function () {
            var writeResult = client.write('show stat\r\n');

            // Get data from unix socket
            client.on('data', function (data) {
                csv.parse(data.toString(), {columns:true}, function (err, parsedData) {
                    if (err) {
                        console.log(err);
                    }else {
                        if (monitorServer !== null) {
                            var sendData = {};
                            for(var i=0; i<servers.length; i++) {

                                var sendData = {
                                    HAProxy_IP: servers[i].backend.ip+':'+servers[i].backend.port,
                                    Cluster_Count: servers[i].frontend.length,
									CPU_Usage: 0,
									Available_Memory: 0,
									Traffic_Total: 0,
									Traffic_Sent: 0,
									Traffic_Received: 0,
                                    Cluster: []
                                };

                                var realIndex = 1;
								var trafficIn = 0;
								var trafficOut = 0;

                                for(var j=0; j<parsedData.length; j++) {
                                    if (parsedData[j]['# pxname'] === servers[i].backend.name &&
                                        parsedData[j]['svname'] !== 'FRONTEND' &&
                                        parsedData[j]['svname'] !== 'BACKEND') {
										
										var status = parsedData[j]['status'];
										if (status === 'UP') {
											status = 'Working';
										}else if (status === 'MAINT') {
											status = 'Updating';
										}else {
											status = 'Disabled';
										}

                                        sendData.Cluster.push({
                                            Cluster_Index: realIndex,
                                            CPU_Usage: parsedData[j]['qcur'],
											Available_Memory: parsedData[j]['scur'],
                                            Traffic_Total: parsedData[j]['bin']*1+parsedData[j]['bout']*1,
                                            Traffic_Sent: parsedData[j]['bin'],
                                            Traffic_Received: parsedData[j]['bout'],
                                            Cluster_Status: status
                                        });
										
										trafficIn += parsedData[j]['bin']*1;
										trafficOut += parsedData[j]['bout']*1;
						
                                        realIndex++;
                                    }else if (parsedData[j]['svname'] === 'BACKEND') {
										sendData.CPU_Usage = parsedData[j]['qcur'];
										sendData.Available_Memory = parsedData[j]['scur'];
									}
                                }

								sendData.Traffic_Sent = trafficOut;
								sendData.Traffic_Received = trafficIn;
								sendData.Traffic_Total = trafficIn + trafficOut;
                            }

                            //winston.info(sendData);

                            monitorServer.write(JSON.stringify(sendData), 'utf8');
                        }

                        parsedData.sort(compare);
                        global.haproxyStat = parsedData;

                        var now = new Date();
                        winston.info('['+now.toLocaleTimeString()+'] HAProxy status polled');
                    }
                });
                client.destroy();
            });

            client.on('error', function (error) {
                console.log('Error Connection: '+error);
                client.destroy();
            });

            client.on('end', function (data) {
                
            });
        });
    },
    start: false
});

// Send HAProxy status

monitorServer = net.createConnection(5000, '192.168.0.16');

monitorServer.on('connect', function (socket) {
    job.start();
});

monitorServer.on('data', function (data) {

	try {
    var recvData = JSON.parse(data.toString());

    if (recvData.signal === 'Attach') {
        if (readCfgData !== null) {
            var newCfgData = readCfgData+'\tserver temp_app '+recvData.ip+' check';

            var tmpHaproxyCfgPath = haproxyCfgDir+'haproxy.tmp.cfg';

            fs.writeFile(tmpHaproxyCfgPath, newCfgData, function (error) {
                if (error) {
                    throw error;
                }
            
                // After write success
                winston.info('haproxy -f '+tmpHaproxyCfgPath+' -p '+pidPath+' -sf $(cat '+pidPath+')');

                exec('sudo haproxy -f '+tmpHaproxyCfgPath+' -p '+pidPath+' -sf $(cat '+pidPath+')', function (error, stdout, stderr) {
                    winston.info(stdout);
                    winston.error(stderr);
                });

            });
        }
    }else if (recvData.signal === 'Detach') {
        if (readCfgData !== null) {
            var tmpHaproxyCfgPath = haproxyCfgDir+'haproxy.tmp.cfg';

            fs.writeFile(tmpHaproxyCfgPath, readCfgData, function (error) {
                if (error) {
                    throw error;
                }
            
                // After write success
                winston.info('haproxy -f '+tmpHaproxyCfgPath+' -p '+pidPath+' -sf $(cat '+pidPath+')');

                exec('sudo haproxy -f '+tmpHaproxyCfgPath+' -p '+pidPath+' -sf $(cat '+pidPath+')', function (error, stdout, stderr) {
                    winston.info(stdout);
                    winston.error(stderr);
                });

            });
        }
    }
	} catch (e) {
	}
});

function compare(a, b) {
    if (a.scur < b.scrur)
        return -1;
    if (a.scur > b.scur)
        return 1;
    return 0;
}

// error handlers

// development error handler
// will print stacktrace
if (app.get('env') === 'development') {
    app.use(function(err, req, res, next) {
        res.status(err.status || 500);
        res.render('error', {
            message: err.message,
            error: err,
            title: 'error'
        });
    });
}

// production error handler
// no stacktraces leaked to user
app.use(function(err, req, res, next) {
    res.status(err.status || 500);
    res.render('error', {
        message: err.message,
        error: {},
        title: 'error'
    });
});

module.exports = app;

app.set('port', process.env.PORT || 9001);

app.listen(app.get('port'), function() {
  console.log('Express server listening on port ' + app.get('port'));
});
