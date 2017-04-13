#!/usr/bin/python
# load the database to a fresh server
# usage: load.py dump.json http://localhost:9000
# validation: curl -X POST http://localhost:9000/validateAll (add force=true query param to force validation)
# if validating multiple large feeds, you may need to run application with more GBs, e.g. java -Xmx6G -jar target/datatools.jar

from sys import argv
import urllib2

server = argv[2]
# strip trailing slash to normalize url
server = server if not server.endswith('/') else server[:-1]

# TODO: don't load everything into RAM when loading
inf = open(argv[1])
dump = inf.read()

print dump[0:79]

req = urllib2.Request(server + '/load', dump, {'Content-Type': 'application/json', 'Content-Length': len(dump)})
opener = urllib2.build_opener()

try:
    opener.open(req)
except urllib2.URLError, e:
    print e.reason
    print e.read()
