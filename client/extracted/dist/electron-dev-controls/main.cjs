const __mod=require('node:module');const __p=require('node:path');const __depsDir=__p.join(__dirname,'..','deps');process.env.NODE_PATH=__depsDir+(process.env.NODE_PATH?__p.delimiter+process.env.NODE_PATH:'');__mod.Module._initPaths();const __import_meta_url=require('node:url').pathToFileURL(__filename).href;
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// C:/b/sand-release-cache/019fefbf-addb-4659-b7b0-14ab88f40d40/scratch/pnpm-virtual-store/adm-zip@0.5.16/node_modules/adm-zip/util/constants.js
var require_constants = __commonJS({
  "C:/b/sand-release-cache/019fefbf-addb-4659-b7b0-14ab88f40d40/scratch/pnpm-virtual-store/adm-zip@0.5.16/node_modules/adm-zip/util/constants.js"(exports2, module2) {
    module2.exports = {
      /* The local file header */
      LOCHDR: 30,
      // LOC header size
      LOCSIG: 67324752,
      // "PK\003\004"
      LOCVER: 4,
      // version needed to extract
      LOCFLG: 6,
      // general purpose bit flag
      LOCHOW: 8,
      // compression method
      LOCTIM: 10,
      // modification time (2 bytes time, 2 bytes date)
      LOCCRC: 14,
      // uncompressed file crc-32 value
      LOCSIZ: 18,
      // compressed size
      LOCLEN: 22,
      // uncompressed size
      LOCNAM: 26,
      // filename length
      LOCEXT: 28,
      // extra field length
      /* The Data descriptor */
      EXTSIG: 134695760,
      // "PK\007\008"
      EXTHDR: 16,
      // EXT header size
      EXTCRC: 4,
      // uncompressed file crc-32 value
      EXTSIZ: 8,
      // compressed size
      EXTLEN: 12,
      // uncompressed size
      /* The central directory file header */
      CENHDR: 46,
      // CEN header size
      CENSIG: 33639248,
      // "PK\001\002"
      CENVEM: 4,
      // version made by
      CENVER: 6,
      // version needed to extract
      CENFLG: 8,
      // encrypt, decrypt flags
      CENHOW: 10,
      // compression method
      CENTIM: 12,
      // modification time (2 bytes time, 2 bytes date)
      CENCRC: 16,
      // uncompressed file crc-32 value
      CENSIZ: 20,
      // compressed size
      CENLEN: 24,
      // uncompressed size
      CENNAM: 28,
      // filename length
      CENEXT: 30,
      // extra field length
      CENCOM: 32,
      // file comment length
      CENDSK: 34,
      // volume number start
      CENATT: 36,
      // internal file attributes
      CENATX: 38,
      // external file attributes (host system dependent)
      CENOFF: 42,
      // LOC header offset
      /* The entries in the end of central directory */
      ENDHDR: 22,
      // END header size
      ENDSIG: 101010256,
      // "PK\005\006"
      ENDSUB: 8,
      // number of entries on this disk
      ENDTOT: 10,
      // total number of entries
      ENDSIZ: 12,
      // central directory size in bytes
      ENDOFF: 16,
      // offset of first CEN header
      ENDCOM: 20,
      // zip file comment length
      END64HDR: 20,
      // zip64 END header size
      END64SIG: 117853008,
      // zip64 Locator signature, "PK\006\007"
      END64START: 4,
      // number of the disk with the start of the zip64
      END64OFF: 8,
      // relative offset of the zip64 end of central directory
      END64NUMDISKS: 16,
      // total number of disks
      ZIP64SIG: 101075792,
      // zip64 signature, "PK\006\006"
      ZIP64HDR: 56,
      // zip64 record minimum size
      ZIP64LEAD: 12,
      // leading bytes at the start of the record, not counted by the value stored in ZIP64SIZE
      ZIP64SIZE: 4,
      // zip64 size of the central directory record
      ZIP64VEM: 12,
      // zip64 version made by
      ZIP64VER: 14,
      // zip64 version needed to extract
      ZIP64DSK: 16,
      // zip64 number of this disk
      ZIP64DSKDIR: 20,
      // number of the disk with the start of the record directory
      ZIP64SUB: 24,
      // number of entries on this disk
      ZIP64TOT: 32,
      // total number of entries
      ZIP64SIZB: 40,
      // zip64 central directory size in bytes
      ZIP64OFF: 48,
      // offset of start of central directory with respect to the starting disk number
      ZIP64EXTRA: 56,
      // extensible data sector
      /* Compression methods */
      STORED: 0,
      // no compression
      SHRUNK: 1,
      // shrunk
      REDUCED1: 2,
      // reduced with compression factor 1
      REDUCED2: 3,
      // reduced with compression factor 2
      REDUCED3: 4,
      // reduced with compression factor 3
      REDUCED4: 5,
      // reduced with compression factor 4
      IMPLODED: 6,
      // imploded
      // 7 reserved for Tokenizing compression algorithm
      DEFLATED: 8,
      // deflated
      ENHANCED_DEFLATED: 9,
      // enhanced deflated
      PKWARE: 10,
      // PKWare DCL imploded
      // 11 reserved by PKWARE
      BZIP2: 12,
      //  compressed using BZIP2
      // 13 reserved by PKWARE
      LZMA: 14,
      // LZMA
      // 15-17 reserved by PKWARE
      IBM_TERSE: 18,
      // compressed using IBM TERSE
      IBM_LZ77: 19,
      // IBM LZ77 z
      AES_ENCRYPT: 99,
      // WinZIP AES encryption method
      /* General purpose bit flag */
      // values can obtained with expression 2**bitnr
      FLG_ENC: 1,
      // Bit 0: encrypted file
      FLG_COMP1: 2,
      // Bit 1, compression option
      FLG_COMP2: 4,
      // Bit 2, compression option
      FLG_DESC: 8,
      // Bit 3, data descriptor
      FLG_ENH: 16,
      // Bit 4, enhanced deflating
      FLG_PATCH: 32,
      // Bit 5, indicates that the file is compressed patched data.
      FLG_STR: 64,
      // Bit 6, strong encryption (patented)
      // Bits 7-10: Currently unused.
      FLG_EFS: 2048,
      // Bit 11: Language encoding flag (EFS)
      // Bit 12: Reserved by PKWARE for enhanced compression.
      // Bit 13: encrypted the Central Directory (patented).
      // Bits 14-15: Reserved by PKWARE.
      FLG_MSK: 4096,
      // mask header values
      /* Load type */
      FILE: 2,
      BUFFER: 1,
      NONE: 0,
      /* 4.5 Extensible data fields */
      EF_ID: 0,
      EF_SIZE: 2,
      /* Header IDs */
      ID_ZIP64: 1,
      ID_AVINFO: 7,
      ID_PFS: 8,
      ID_OS2: 9,
      ID_NTFS: 10,
      ID_OPENVMS: 12,
      ID_UNIX: 13,
      ID_FORK: 14,
      ID_PATCH: 15,
      ID_X509_PKCS7: 20,
      ID_X509_CERTID_F: 21,
      ID_X509_CERTID_C: 22,
      ID_STRONGENC: 23,
      ID_RECORD_MGT: 24,
      ID_X509_PKCS7_RL: 25,
      ID_IBM1: 101,
      ID_IBM2: 102,
      ID_POSZIP: 18064,
      EF_ZIP64_OR_32: 4294967295,
      EF_ZIP64_OR_16: 65535,
      EF_ZIP64_SUNCOMP: 0,
      EF_ZIP64_SCOMP: 8,
      EF_ZIP64_RHO: 16,
      EF_ZIP64_DSN: 24
    };
  }
});

// C:/b/sand-release-cache/019fefbf-addb-4659-b7b0-14ab88f40d40/scratch/pnpm-virtual-store/adm-zip@0.5.16/node_modules/adm-zip/util/errors.js
var require_errors = __commonJS({
  "C:/b/sand-release-cache/019fefbf-addb-4659-b7b0-14ab88f40d40/scratch/pnpm-virtual-store/adm-zip@0.5.16/node_modules/adm-zip/util/errors.js"(exports2) {
    var errors = {
      /* Header error messages */
      INVALID_LOC: "Invalid LOC header (bad signature)",
      INVALID_CEN: "Invalid CEN header (bad signature)",
      INVALID_END: "Invalid END header (bad signature)",
      /* Descriptor */
      DESCRIPTOR_NOT_EXIST: "No descriptor present",
      DESCRIPTOR_UNKNOWN: "Unknown descriptor format",
      DESCRIPTOR_FAULTY: "Descriptor data is malformed",
      /* ZipEntry error messages*/
      NO_DATA: "Nothing to decompress",
      BAD_CRC: "CRC32 checksum failed {0}",
      FILE_IN_THE_WAY: "There is a file in the way: {0}",
      UNKNOWN_METHOD: "Invalid/unsupported compression method",
      /* Inflater error messages */
      AVAIL_DATA: "inflate::Available inflate data did not terminate",
      INVALID_DISTANCE: "inflate::Invalid literal/length or distance code in fixed or dynamic block",
      TO_MANY_CODES: "inflate::Dynamic block code description: too many length or distance codes",
      INVALID_REPEAT_LEN: "inflate::Dynamic block code description: repeat more than specified lengths",
      INVALID_REPEAT_FIRST: "inflate::Dynamic block code description: repeat lengths with no first length",
      INCOMPLETE_CODES: "inflate::Dynamic block code description: code lengths codes incomplete",
      INVALID_DYN_DISTANCE: "inflate::Dynamic block code description: invalid distance code lengths",
      INVALID_CODES_LEN: "inflate::Dynamic block code description: invalid literal/length code lengths",
      INVALID_STORE_BLOCK: "inflate::Stored block length did not match one's complement",
      INVALID_BLOCK_TYPE: "inflate::Invalid block type (type == 3)",
      /* ADM-ZIP error messages */
      CANT_EXTRACT_FILE: "Could not extract the file",
      CANT_OVERRIDE: "Target file already exists",
      DISK_ENTRY_TOO_LARGE: "Number of disk entries is too large",
      NO_ZIP: "No zip file was loaded",
      NO_ENTRY: "Entry doesn't exist",
      DIRECTORY_CONTENT_ERROR: "A directory cannot have content",
      FILE_NOT_FOUND: 'File not found: "{0}"',
      NOT_IMPLEMENTED: "Not implemented",
      INVALID_FILENAME: "Invalid filename",
      INVALID_FORMAT: "Invalid or unsupported zip format. No END header found",
      INVALID_PASS_PARAM: "Incompatible password parameter",
      WRONG_PASSWORD: "Wrong Password",
      /* ADM-ZIP */
      COMMENT_TOO_LONG: "Comment is too long",
      // Comment can be max 65535 bytes long (NOTE: some non-US characters may take more space)
      EXTRA_FIELD_PARSE_ERROR: "Extra field parsing error"
    };
    function E(message) {
      return function(...args) {
        if (args.length) {
          message = message.replace(/\{(\d)\}/g, (_, n) => args[n] || "");
        }
        return new Error("ADM-ZIP: " + message);
      };
    }
    for (const msg of Object.keys(errors)) {
      exports2[msg] = E(errors[msg]);
    }
  }
});

// C:/b/sand-release-cache/019fefbf-addb-4659-b7b0-14ab88f40d40/scratch/pnpm-virtual-store/adm-zip@0.5.16/node_modules/adm-zip/util/utils.js
var require_utils = __commonJS({
  "C:/b/sand-release-cache/019fefbf-addb-4659-b7b0-14ab88f40d40/scratch/pnpm-virtual-store/adm-zip@0.5.16/node_modules/adm-zip/util/utils.js"(exports2, module2) {
    var fsystem = require("fs");
    var pth = require("path");
    var Constants = require_constants();
    var Errors = require_errors();
    var isWin = typeof process === "object" && "win32" === process.platform;
    var is_Obj = (obj) => typeof obj === "object" && obj !== null;
    var crcTable = new Uint32Array(256).map((t, c) => {
      for (let k = 0; k < 8; k++) {
        if ((c & 1) !== 0) {
          c = 3988292384 ^ c >>> 1;
        } else {
          c >>>= 1;
        }
      }
      return c >>> 0;
    });
    function Utils(opts) {
      this.sep = pth.sep;
      this.fs = fsystem;
      if (is_Obj(opts)) {
        if (is_Obj(opts.fs) && typeof opts.fs.statSync === "function") {
          this.fs = opts.fs;
        }
      }
    }
    module2.exports = Utils;
    Utils.prototype.makeDir = function(folder) {
      const self = this;
      function mkdirSync2(fpath) {
        let resolvedPath = fpath.split(self.sep)[0];
        fpath.split(self.sep).forEach(function(name) {
          if (!name || name.substr(-1, 1) === ":") return;
          resolvedPath += self.sep + name;
          var stat;
          try {
            stat = self.fs.statSync(resolvedPath);
          } catch (e) {
            self.fs.mkdirSync(resolvedPath);
          }
          if (stat && stat.isFile()) throw Errors.FILE_IN_THE_WAY(`"${resolvedPath}"`);
        });
      }
      mkdirSync2(folder);
    };
    Utils.prototype.writeFileTo = function(path3, content, overwrite, attr) {
      const self = this;
      if (self.fs.existsSync(path3)) {
        if (!overwrite) return false;
        var stat = self.fs.statSync(path3);
        if (stat.isDirectory()) {
          return false;
        }
      }
      var folder = pth.dirname(path3);
      if (!self.fs.existsSync(folder)) {
        self.makeDir(folder);
      }
      var fd;
      try {
        fd = self.fs.openSync(path3, "w", 438);
      } catch (e) {
        self.fs.chmodSync(path3, 438);
        fd = self.fs.openSync(path3, "w", 438);
      }
      if (fd) {
        try {
          self.fs.writeSync(fd, content, 0, content.length, 0);
        } finally {
          self.fs.closeSync(fd);
        }
      }
      self.fs.chmodSync(path3, attr || 438);
      return true;
    };
    Utils.prototype.writeFileToAsync = function(path3, content, overwrite, attr, callback) {
      if (typeof attr === "function") {
        callback = attr;
        attr = void 0;
      }
      const self = this;
      self.fs.exists(path3, function(exist) {
        if (exist && !overwrite) return callback(false);
        self.fs.stat(path3, function(err, stat) {
          if (exist && stat.isDirectory()) {
            return callback(false);
          }
          var folder = pth.dirname(path3);
          self.fs.exists(folder, function(exists) {
            if (!exists) self.makeDir(folder);
            self.fs.open(path3, "w", 438, function(err2, fd) {
              if (err2) {
                self.fs.chmod(path3, 438, function() {
                  self.fs.open(path3, "w", 438, function(err3, fd2) {
                    self.fs.write(fd2, content, 0, content.length, 0, function() {
                      self.fs.close(fd2, function() {
                        self.fs.chmod(path3, attr || 438, function() {
                          callback(true);
                        });
                      });
                    });
                  });
                });
              } else if (fd) {
                self.fs.write(fd, content, 0, content.length, 0, function() {
                  self.fs.close(fd, function() {
                    self.fs.chmod(path3, attr || 438, function() {
                      callback(true);
                    });
                  });
                });
              } else {
                self.fs.chmod(path3, attr || 438, function() {
                  callback(true);
                });
              }
            });
          });
        });
      });
    };
    Utils.prototype.findFiles = function(path3) {
      const self = this;
      function findSync(dir, pattern, recursive) {
        if (typeof pattern === "boolean") {
          recursive = pattern;
          pattern = void 0;
        }
        let files = [];
        self.fs.readdirSync(dir).forEach(function(file) {
          const path4 = pth.join(dir, file);
          const stat = self.fs.statSync(path4);
          if (!pattern || pattern.test(path4)) {
            files.push(pth.normalize(path4) + (stat.isDirectory() ? self.sep : ""));
          }
          if (stat.isDirectory() && recursive) files = files.concat(findSync(path4, pattern, recursive));
        });
        return files;
      }
      return findSync(path3, void 0, true);
    };
    Utils.prototype.findFilesAsync = function(dir, cb) {
      const self = this;
      let results = [];
      self.fs.readdir(dir, function(err, list) {
        if (err) return cb(err);
        let list_length = list.length;
        if (!list_length) return cb(null, results);
        list.forEach(function(file) {
          file = pth.join(dir, file);
          self.fs.stat(file, function(err2, stat) {
            if (err2) return cb(err2);
            if (stat) {
              results.push(pth.normalize(file) + (stat.isDirectory() ? self.sep : ""));
              if (stat.isDirectory()) {
                self.findFilesAsync(file, function(err3, res) {
                  if (err3) return cb(err3);
                  results = results.concat(res);
                  if (!--list_length) cb(null, results);
                });
              } else {
                if (!--list_length) cb(null, results);
              }
            }
          });
        });
      });
    };
    Utils.prototype.getAttributes = function() {
    };
    Utils.prototype.setAttributes = function() {
    };
    Utils.crc32update = function(crc, byte) {
      return crcTable[(crc ^ byte) & 255] ^ crc >>> 8;
    };
    Utils.crc32 = function(buf) {
      if (typeof buf === "string") {
        buf = Buffer.from(buf, "utf8");
      }
      let len = buf.length;
      let crc = ~0;
      for (let off = 0; off < len; ) crc = Utils.crc32update(crc, buf[off++]);
      return ~crc >>> 0;
    };
    Utils.methodToString = function(method) {
      switch (method) {
        case Constants.STORED:
          return "STORED (" + method + ")";
        case Constants.DEFLATED:
          return "DEFLATED (" + method + ")";
        default:
          return "UNSUPPORTED (" + method + ")";
      }
    };
    Utils.canonical = function(path3) {
      if (!path3) return "";
      const safeSuffix = pth.posix.normalize("/" + path3.split("\\").join("/"));
      return pth.join(".", safeSuffix);
    };
    Utils.zipnamefix = function(path3) {
      if (!path3) return "";
      const safeSuffix = pth.posix.normalize("/" + path3.split("\\").join("/"));
      return pth.posix.join(".", safeSuffix);
    };
    Utils.findLast = function(arr, callback) {
      if (!Array.isArray(arr)) throw new TypeError("arr is not array");
      const len = arr.length >>> 0;
      for (let i = len - 1; i >= 0; i--) {
        if (callback(arr[i], i, arr)) {
          return arr[i];
        }
      }
      return void 0;
    };
    Utils.sanitize = function(prefix, name) {
      prefix = pth.resolve(pth.normalize(prefix));
      var parts = name.split("/");
      for (var i = 0, l = parts.length; i < l; i++) {
        var path3 = pth.normalize(pth.join(prefix, parts.slice(i, l).join(pth.sep)));
        if (path3.indexOf(prefix) === 0) {
          return path3;
        }
      }
      return pth.normalize(pth.join(prefix, pth.basename(name)));
    };
    Utils.toBuffer = function toBuffer(input, encoder) {
      if (Buffer.isBuffer(input)) {
        return input;
      } else if (input instanceof Uint8Array) {
        return Buffer.from(input);
      } else {
        return typeof input === "string" ? encoder(input) : Buffer.alloc(0);
      }
    };
    Utils.readBigUInt64LE = function(buffer, index) {
      var slice = Buffer.from(buffer.slice(index, index + 8));
      slice.swap64();
      return parseInt(`0x${slice.toString("hex")}`);
    };
    Utils.fromDOS2Date = function(val) {
      return new Date((val >> 25 & 127) + 1980, Math.max((val >> 21 & 15) - 1, 0), Math.max(val >> 16 & 31, 1), val >> 11 & 31, val >> 5 & 63, (val & 31) << 1);
    };
    Utils.fromDate2DOS = function(val) {
      let date = 0;
      let time = 0;
      if (val.getFullYear() > 1979) {
        date = (val.getFullYear() - 1980 & 127) << 9 | val.getMonth() + 1 << 5 | val.getDate();
        time = val.getHours() << 11 | val.getMinutes() << 5 | val.getSeconds() >> 1;
      }
      return date << 16 | time;
    };
    Utils.isWin = isWin;
    Utils.crcTable = crcTable;
  }
});

// C:/b/sand-release-cache/019fefbf-addb-4659-b7b0-14ab88f40d40/scratch/pnpm-virtual-store/adm-zip@0.5.16/node_modules/adm-zip/util/fattr.js
var require_fattr = __commonJS({
  "C:/b/sand-release-cache/019fefbf-addb-4659-b7b0-14ab88f40d40/scratch/pnpm-virtual-store/adm-zip@0.5.16/node_modules/adm-zip/util/fattr.js"(exports2, module2) {
    var pth = require("path");
    module2.exports = function(path3, { fs: fs2 }) {
      var _path = path3 || "", _obj = newAttr(), _stat = null;
      function newAttr() {
        return {
          directory: false,
          readonly: false,
          hidden: false,
          executable: false,
          mtime: 0,
          atime: 0
        };
      }
      if (_path && fs2.existsSync(_path)) {
        _stat = fs2.statSync(_path);
        _obj.directory = _stat.isDirectory();
        _obj.mtime = _stat.mtime;
        _obj.atime = _stat.atime;
        _obj.executable = (73 & _stat.mode) !== 0;
        _obj.readonly = (128 & _stat.mode) === 0;
        _obj.hidden = pth.basename(_path)[0] === ".";
      } else {
        console.warn("Invalid path: " + _path);
      }
      return {
        get directory() {
          return _obj.directory;
        },
        get readOnly() {
          return _obj.readonly;
        },
        get hidden() {
          return _obj.hidden;
        },
        get mtime() {
          return _obj.mtime;
        },
        get atime() {
          return _obj.atime;
        },
        get executable() {
          return _obj.executable;
        },
        decodeAttributes: function() {
        },
        encodeAttributes: function() {
        },
        toJSON: function() {
          return {
            path: _path,
            isDirectory: _obj.directory,
            isReadOnly: _obj.readonly,
            isHidden: _obj.hidden,
            isExecutable: _obj.executable,
            mTime: _obj.mtime,
            aTime: _obj.atime
          };
        },
        toString: function() {
          return JSON.stringify(this.toJSON(), null, "	");
        }
      };
    };
  }
});

// C:/b/sand-release-cache/019fefbf-addb-4659-b7b0-14ab88f40d40/scratch/pnpm-virtual-store/adm-zip@0.5.16/node_modules/adm-zip/util/decoder.js
var require_decoder = __commonJS({
  "C:/b/sand-release-cache/019fefbf-addb-4659-b7b0-14ab88f40d40/scratch/pnpm-virtual-store/adm-zip@0.5.16/node_modules/adm-zip/util/decoder.js"(exports2, module2) {
    module2.exports = {
      efs: true,
      encode: (data) => Buffer.from(data, "utf8"),
      decode: (data) => data.toString("utf8")
    };
  }
});

// C:/b/sand-release-cache/019fefbf-addb-4659-b7b0-14ab88f40d40/scratch/pnpm-virtual-store/adm-zip@0.5.16/node_modules/adm-zip/util/index.js
var require_util = __commonJS({
  "C:/b/sand-release-cache/019fefbf-addb-4659-b7b0-14ab88f40d40/scratch/pnpm-virtual-store/adm-zip@0.5.16/node_modules/adm-zip/util/index.js"(exports2, module2) {
    module2.exports = require_utils();
    module2.exports.Constants = require_constants();
    module2.exports.Errors = require_errors();
    module2.exports.FileAttr = require_fattr();
    module2.exports.decoder = require_decoder();
  }
});

// C:/b/sand-release-cache/019fefbf-addb-4659-b7b0-14ab88f40d40/scratch/pnpm-virtual-store/adm-zip@0.5.16/node_modules/adm-zip/headers/entryHeader.js
var require_entryHeader = __commonJS({
  "C:/b/sand-release-cache/019fefbf-addb-4659-b7b0-14ab88f40d40/scratch/pnpm-virtual-store/adm-zip@0.5.16/node_modules/adm-zip/headers/entryHeader.js"(exports2, module2) {
    var Utils = require_util();
    var Constants = Utils.Constants;
    module2.exports = function() {
      var _verMade = 20, _version = 10, _flags = 0, _method = 0, _time = 0, _crc = 0, _compressedSize = 0, _size = 0, _fnameLen = 0, _extraLen = 0, _comLen = 0, _diskStart = 0, _inattr = 0, _attr = 0, _offset = 0;
      _verMade |= Utils.isWin ? 2560 : 768;
      _flags |= Constants.FLG_EFS;
      const _localHeader = {
        extraLen: 0
      };
      const uint32 = (val) => Math.max(0, val) >>> 0;
      const uint16 = (val) => Math.max(0, val) & 65535;
      const uint8 = (val) => Math.max(0, val) & 255;
      _time = Utils.fromDate2DOS(/* @__PURE__ */ new Date());
      return {
        get made() {
          return _verMade;
        },
        set made(val) {
          _verMade = val;
        },
        get version() {
          return _version;
        },
        set version(val) {
          _version = val;
        },
        get flags() {
          return _flags;
        },
        set flags(val) {
          _flags = val;
        },
        get flags_efs() {
          return (_flags & Constants.FLG_EFS) > 0;
        },
        set flags_efs(val) {
          if (val) {
            _flags |= Constants.FLG_EFS;
          } else {
            _flags &= ~Constants.FLG_EFS;
          }
        },
        get flags_desc() {
          return (_flags & Constants.FLG_DESC) > 0;
        },
        set flags_desc(val) {
          if (val) {
            _flags |= Constants.FLG_DESC;
          } else {
            _flags &= ~Constants.FLG_DESC;
          }
        },
        get method() {
          return _method;
        },
        set method(val) {
          switch (val) {
            case Constants.STORED:
              this.version = 10;
            case Constants.DEFLATED:
            default:
              this.version = 20;
          }
          _method = val;
        },
        get time() {
          return Utils.fromDOS2Date(this.timeval);
        },
        set time(val) {
          this.timeval = Utils.fromDate2DOS(val);
        },
        get timeval() {
          return _time;
        },
        set timeval(val) {
          _time = uint32(val);
        },
        get timeHighByte() {
          return uint8(_time >>> 8);
        },
        get crc() {
          return _crc;
        },
        set crc(val) {
          _crc = uint32(val);
        },
        get compressedSize() {
          return _compressedSize;
        },
        set compressedSize(val) {
          _compressedSize = uint32(val);
        },
        get size() {
          return _size;
        },
        set size(val) {
          _size = uint32(val);
        },
        get fileNameLength() {
          return _fnameLen;
        },
        set fileNameLength(val) {
          _fnameLen = val;
        },
        get extraLength() {
          return _extraLen;
        },
        set extraLength(val) {
          _extraLen = val;
        },
        get extraLocalLength() {
          return _localHeader.extraLen;
        },
        set extraLocalLength(val) {
          _localHeader.extraLen = val;
        },
        get commentLength() {
          return _comLen;
        },
        set commentLength(val) {
          _comLen = val;
        },
        get diskNumStart() {
          return _diskStart;
        },
        set diskNumStart(val) {
          _diskStart = uint32(val);
        },
        get inAttr() {
          return _inattr;
        },
        set inAttr(val) {
          _inattr = uint32(val);
        },
        get attr() {
          return _attr;
        },
        set attr(val) {
          _attr = uint32(val);
        },
        // get Unix file permissions
        get fileAttr() {
          return (_attr || 0) >> 16 & 4095;
        },
        get offset() {
          return _offset;
        },
        set offset(val) {
          _offset = uint32(val);
        },
        get encrypted() {
          return (_flags & Constants.FLG_ENC) === Constants.FLG_ENC;
        },
        get centralHeaderSize() {
          return Constants.CENHDR + _fnameLen + _extraLen + _comLen;
        },
        get realDataOffset() {
          return _offset + Constants.LOCHDR + _localHeader.fnameLen + _localHeader.extraLen;
        },
        get localHeader() {
          return _localHeader;
        },
        loadLocalHeaderFromBinary: function(input) {
          var data = input.slice(_offset, _offset + Constants.LOCHDR);
          if (data.readUInt32LE(0) !== Constants.LOCSIG) {
            throw Utils.Errors.INVALID_LOC();
          }
          _localHeader.version = data.readUInt16LE(Constants.LOCVER);
          _localHeader.flags = data.readUInt16LE(Constants.LOCFLG);
          _localHeader.method = data.readUInt16LE(Constants.LOCHOW);
          _localHeader.time = data.readUInt32LE(Constants.LOCTIM);
          _localHeader.crc = data.readUInt32LE(Constants.LOCCRC);
          _localHeader.compressedSize = data.readUInt32LE(Constants.LOCSIZ);
          _localHeader.size = data.readUInt32LE(Constants.LOCLEN);
          _localHeader.fnameLen = data.readUInt16LE(Constants.LOCNAM);
          _localHeader.extraLen = data.readUInt16LE(Constants.LOCEXT);
          const extraStart = _offset + Constants.LOCHDR + _localHeader.fnameLen;
          const extraEnd = extraStart + _localHeader.extraLen;
          return input.slice(extraStart, extraEnd);
        },
        loadFromBinary: function(data) {
          if (data.length !== Constants.CENHDR || data.readUInt32LE(0) !== Constants.CENSIG) {
            throw Utils.Errors.INVALID_CEN();
          }
          _verMade = data.readUInt16LE(Constants.CENVEM);
          _version = data.readUInt16LE(Constants.CENVER);
          _flags = data.readUInt16LE(Constants.CENFLG);
          _method = data.readUInt16LE(Constants.CENHOW);
          _time = data.readUInt32LE(Constants.CENTIM);
          _crc = data.readUInt32LE(Constants.CENCRC);
          _compressedSize = data.readUInt32LE(Constants.CENSIZ);
          _size = data.readUInt32LE(Constants.CENLEN);
          _fnameLen = data.readUInt16LE(Constants.CENNAM);
          _extraLen = data.readUInt16LE(Constants.CENEXT);
          _comLen = data.readUInt16LE(Constants.CENCOM);
          _diskStart = data.readUInt16LE(Constants.CENDSK);
          _inattr = data.readUInt16LE(Constants.CENATT);
          _attr = data.readUInt32LE(Constants.CENATX);
          _offset = data.readUInt32LE(Constants.CENOFF);
        },
        localHeaderToBinary: function() {
          var data = Buffer.alloc(Constants.LOCHDR);
          data.writeUInt32LE(Constants.LOCSIG, 0);
          data.writeUInt16LE(_version, Constants.LOCVER);
          data.writeUInt16LE(_flags, Constants.LOCFLG);
          data.writeUInt16LE(_method, Constants.LOCHOW);
          data.writeUInt32LE(_time, Constants.LOCTIM);
          data.writeUInt32LE(_crc, Constants.LOCCRC);
          data.writeUInt32LE(_compressedSize, Constants.LOCSIZ);
          data.writeUInt32LE(_size, Constants.LOCLEN);
          data.writeUInt16LE(_fnameLen, Constants.LOCNAM);
          data.writeUInt16LE(_localHeader.extraLen, Constants.LOCEXT);
          return data;
        },
        centralHeaderToBinary: function() {
          var data = Buffer.alloc(Constants.CENHDR + _fnameLen + _extraLen + _comLen);
          data.writeUInt32LE(Constants.CENSIG, 0);
          data.writeUInt16LE(_verMade, Constants.CENVEM);
          data.writeUInt16LE(_version, Constants.CENVER);
          data.writeUInt16LE(_flags, Constants.CENFLG);
          data.writeUInt16LE(_method, Constants.CENHOW);
          data.writeUInt32LE(_time, Constants.CENTIM);
          data.writeUInt32LE(_crc, Constants.CENCRC);
          data.writeUInt32LE(_compressedSize, Constants.CENSIZ);
          data.writeUInt32LE(_size, Constants.CENLEN);
          data.writeUInt16LE(_fnameLen, Constants.CENNAM);
          data.writeUInt16LE(_extraLen, Constants.CENEXT);
          data.writeUInt16LE(_comLen, Constants.CENCOM);
          data.writeUInt16LE(_diskStart, Constants.CENDSK);
          data.writeUInt16LE(_inattr, Constants.CENATT);
          data.writeUInt32LE(_attr, Constants.CENATX);
          data.writeUInt32LE(_offset, Constants.CENOFF);
          return data;
        },
        toJSON: function() {
          const bytes = function(nr) {
            return nr + " bytes";
          };
          return {
            made: _verMade,
            version: _version,
            flags: _flags,
            method: Utils.methodToString(_method),
            time: this.time,
            crc: "0x" + _crc.toString(16).toUpperCase(),
            compressedSize: bytes(_compressedSize),
            size: bytes(_size),
            fileNameLength: bytes(_fnameLen),
            extraLength: bytes(_extraLen),
            commentLength: bytes(_comLen),
            diskNumStart: _diskStart,
            inAttr: _inattr,
            attr: _attr,
            offset: _offset,
            centralHeaderSize: bytes(Constants.CENHDR + _fnameLen + _extraLen + _comLen)
          };
        },
        toString: function() {
          return JSON.stringify(this.toJSON(), null, "	");
        }
      };
    };
  }
});

// C:/b/sand-release-cache/019fefbf-addb-4659-b7b0-14ab88f40d40/scratch/pnpm-virtual-store/adm-zip@0.5.16/node_modules/adm-zip/headers/mainHeader.js
var require_mainHeader = __commonJS({
  "C:/b/sand-release-cache/019fefbf-addb-4659-b7b0-14ab88f40d40/scratch/pnpm-virtual-store/adm-zip@0.5.16/node_modules/adm-zip/headers/mainHeader.js"(exports2, module2) {
    var Utils = require_util();
    var Constants = Utils.Constants;
    module2.exports = function() {
      var _volumeEntries = 0, _totalEntries = 0, _size = 0, _offset = 0, _commentLength = 0;
      return {
        get diskEntries() {
          return _volumeEntries;
        },
        set diskEntries(val) {
          _volumeEntries = _totalEntries = val;
        },
        get totalEntries() {
          return _totalEntries;
        },
        set totalEntries(val) {
          _totalEntries = _volumeEntries = val;
        },
        get size() {
          return _size;
        },
        set size(val) {
          _size = val;
        },
        get offset() {
          return _offset;
        },
        set offset(val) {
          _offset = val;
        },
        get commentLength() {
          return _commentLength;
        },
        set commentLength(val) {
          _commentLength = val;
        },
        get mainHeaderSize() {
          return Constants.ENDHDR + _commentLength;
        },
        loadFromBinary: function(data) {
          if ((data.length !== Constants.ENDHDR || data.readUInt32LE(0) !== Constants.ENDSIG) && (data.length < Constants.ZIP64HDR || data.readUInt32LE(0) !== Constants.ZIP64SIG)) {
            throw Utils.Errors.INVALID_END();
          }
          if (data.readUInt32LE(0) === Constants.ENDSIG) {
            _volumeEntries = data.readUInt16LE(Constants.ENDSUB);
            _totalEntries = data.readUInt16LE(Constants.ENDTOT);
            _size = data.readUInt32LE(Constants.ENDSIZ);
            _offset = data.readUInt32LE(Constants.ENDOFF);
            _commentLength = data.readUInt16LE(Constants.ENDCOM);
          } else {
            _volumeEntries = Utils.readBigUInt64LE(data, Constants.ZIP64SUB);
            _totalEntries = Utils.readBigUInt64LE(data, Constants.ZIP64TOT);
            _size = Utils.readBigUInt64LE(data, Constants.ZIP64SIZE);
            _offset = Utils.readBigUInt64LE(data, Constants.ZIP64OFF);
            _commentLength = 0;
          }
        },
        toBinary: function() {
          var b = Buffer.alloc(Constants.ENDHDR + _commentLength);
          b.writeUInt32LE(Constants.ENDSIG, 0);
          b.writeUInt32LE(0, 4);
          b.writeUInt16LE(_volumeEntries, Constants.ENDSUB);
          b.writeUInt16LE(_totalEntries, Constants.ENDTOT);
          b.writeUInt32LE(_size, Constants.ENDSIZ);
          b.writeUInt32LE(_offset, Constants.ENDOFF);
          b.writeUInt16LE(_commentLength, Constants.ENDCOM);
          b.fill(" ", Constants.ENDHDR);
          return b;
        },
        toJSON: function() {
          const offset = function(nr, len) {
            let offs = nr.toString(16).toUpperCase();
            while (offs.length < len) offs = "0" + offs;
            return "0x" + offs;
          };
          return {
            diskEntries: _volumeEntries,
            totalEntries: _totalEntries,
            size: _size + " bytes",
            offset: offset(_offset, 4),
            commentLength: _commentLength
          };
        },
        toString: function() {
          return JSON.stringify(this.toJSON(), null, "	");
        }
      };
    };
  }
});

// C:/b/sand-release-cache/019fefbf-addb-4659-b7b0-14ab88f40d40/scratch/pnpm-virtual-store/adm-zip@0.5.16/node_modules/adm-zip/headers/index.js
var require_headers = __commonJS({
  "C:/b/sand-release-cache/019fefbf-addb-4659-b7b0-14ab88f40d40/scratch/pnpm-virtual-store/adm-zip@0.5.16/node_modules/adm-zip/headers/index.js"(exports2) {
    exports2.EntryHeader = require_entryHeader();
    exports2.MainHeader = require_mainHeader();
  }
});

// C:/b/sand-release-cache/019fefbf-addb-4659-b7b0-14ab88f40d40/scratch/pnpm-virtual-store/adm-zip@0.5.16/node_modules/adm-zip/methods/deflater.js
var require_deflater = __commonJS({
  "C:/b/sand-release-cache/019fefbf-addb-4659-b7b0-14ab88f40d40/scratch/pnpm-virtual-store/adm-zip@0.5.16/node_modules/adm-zip/methods/deflater.js"(exports2, module2) {
    module2.exports = function(inbuf) {
      var zlib = require("zlib");
      var opts = { chunkSize: (parseInt(inbuf.length / 1024) + 1) * 1024 };
      return {
        deflate: function() {
          return zlib.deflateRawSync(inbuf, opts);
        },
        deflateAsync: function(callback) {
          var tmp = zlib.createDeflateRaw(opts), parts = [], total = 0;
          tmp.on("data", function(data) {
            parts.push(data);
            total += data.length;
          });
          tmp.on("end", function() {
            var buf = Buffer.alloc(total), written = 0;
            buf.fill(0);
            for (var i = 0; i < parts.length; i++) {
              var part = parts[i];
              part.copy(buf, written);
              written += part.length;
            }
            callback && callback(buf);
          });
          tmp.end(inbuf);
        }
      };
    };
  }
});

// C:/b/sand-release-cache/019fefbf-addb-4659-b7b0-14ab88f40d40/scratch/pnpm-virtual-store/adm-zip@0.5.16/node_modules/adm-zip/methods/inflater.js
var require_inflater = __commonJS({
  "C:/b/sand-release-cache/019fefbf-addb-4659-b7b0-14ab88f40d40/scratch/pnpm-virtual-store/adm-zip@0.5.16/node_modules/adm-zip/methods/inflater.js"(exports2, module2) {
    var version = +(process.versions ? process.versions.node : "").split(".")[0] || 0;
    module2.exports = function(inbuf, expectedLength) {
      var zlib = require("zlib");
      const option = version >= 15 && expectedLength > 0 ? { maxOutputLength: expectedLength } : {};
      return {
        inflate: function() {
          return zlib.inflateRawSync(inbuf, option);
        },
        inflateAsync: function(callback) {
          var tmp = zlib.createInflateRaw(option), parts = [], total = 0;
          tmp.on("data", function(data) {
            parts.push(data);
            total += data.length;
          });
          tmp.on("end", function() {
            var buf = Buffer.alloc(total), written = 0;
            buf.fill(0);
            for (var i = 0; i < parts.length; i++) {
              var part = parts[i];
              part.copy(buf, written);
              written += part.length;
            }
            callback && callback(buf);
          });
          tmp.end(inbuf);
        }
      };
    };
  }
});

// C:/b/sand-release-cache/019fefbf-addb-4659-b7b0-14ab88f40d40/scratch/pnpm-virtual-store/adm-zip@0.5.16/node_modules/adm-zip/methods/zipcrypto.js
var require_zipcrypto = __commonJS({
  "C:/b/sand-release-cache/019fefbf-addb-4659-b7b0-14ab88f40d40/scratch/pnpm-virtual-store/adm-zip@0.5.16/node_modules/adm-zip/methods/zipcrypto.js"(exports2, module2) {
    "use strict";
    var { randomFillSync } = require("crypto");
    var Errors = require_errors();
    var crctable = new Uint32Array(256).map((t, crc) => {
      for (let j = 0; j < 8; j++) {
        if (0 !== (crc & 1)) {
          crc = crc >>> 1 ^ 3988292384;
        } else {
          crc >>>= 1;
        }
      }
      return crc >>> 0;
    });
    var uMul = (a, b) => Math.imul(a, b) >>> 0;
    var crc32update = (pCrc32, bval) => {
      return crctable[(pCrc32 ^ bval) & 255] ^ pCrc32 >>> 8;
    };
    var genSalt = () => {
      if ("function" === typeof randomFillSync) {
        return randomFillSync(Buffer.alloc(12));
      } else {
        return genSalt.node();
      }
    };
    genSalt.node = () => {
      const salt = Buffer.alloc(12);
      const len = salt.length;
      for (let i = 0; i < len; i++) salt[i] = Math.random() * 256 & 255;
      return salt;
    };
    var config = {
      genSalt
    };
    function Initkeys(pw) {
      const pass = Buffer.isBuffer(pw) ? pw : Buffer.from(pw);
      this.keys = new Uint32Array([305419896, 591751049, 878082192]);
      for (let i = 0; i < pass.length; i++) {
        this.updateKeys(pass[i]);
      }
    }
    Initkeys.prototype.updateKeys = function(byteValue) {
      const keys = this.keys;
      keys[0] = crc32update(keys[0], byteValue);
      keys[1] += keys[0] & 255;
      keys[1] = uMul(keys[1], 134775813) + 1;
      keys[2] = crc32update(keys[2], keys[1] >>> 24);
      return byteValue;
    };
    Initkeys.prototype.next = function() {
      const k = (this.keys[2] | 2) >>> 0;
      return uMul(k, k ^ 1) >> 8 & 255;
    };
    function make_decrypter(pwd) {
      const keys = new Initkeys(pwd);
      return function(data) {
        const result = Buffer.alloc(data.length);
        let pos = 0;
        for (let c of data) {
          result[pos++] = keys.updateKeys(c ^ keys.next());
        }
        return result;
      };
    }
    function make_encrypter(pwd) {
      const keys = new Initkeys(pwd);
      return function(data, result, pos = 0) {
        if (!result) result = Buffer.alloc(data.length);
        for (let c of data) {
          const k = keys.next();
          result[pos++] = c ^ k;
          keys.updateKeys(c);
        }
        return result;
      };
    }
    function decrypt(data, header, pwd) {
      if (!data || !Buffer.isBuffer(data) || data.length < 12) {
        return Buffer.alloc(0);
      }
      const decrypter = make_decrypter(pwd);
      const salt = decrypter(data.slice(0, 12));
      const verifyByte = (header.flags & 8) === 8 ? header.timeHighByte : header.crc >>> 24;
      if (salt[11] !== verifyByte) {
        throw Errors.WRONG_PASSWORD();
      }
      return decrypter(data.slice(12));
    }
    function _salter(data) {
      if (Buffer.isBuffer(data) && data.length >= 12) {
        config.genSalt = function() {
          return data.slice(0, 12);
        };
      } else if (data === "node") {
        config.genSalt = genSalt.node;
      } else {
        config.genSalt = genSalt;
      }
    }
    function encrypt(data, header, pwd, oldlike = false) {
      if (data == null) data = Buffer.alloc(0);
      if (!Buffer.isBuffer(data)) data = Buffer.from(data.toString());
      const encrypter = make_encrypter(pwd);
      const salt = config.genSalt();
      salt[11] = header.crc >>> 24 & 255;
      if (oldlike) salt[10] = header.crc >>> 16 & 255;
      const result = Buffer.alloc(data.length + 12);
      encrypter(salt, result);
      return encrypter(data, result, 12);
    }
    module2.exports = { decrypt, encrypt, _salter };
  }
});

// C:/b/sand-release-cache/019fefbf-addb-4659-b7b0-14ab88f40d40/scratch/pnpm-virtual-store/adm-zip@0.5.16/node_modules/adm-zip/methods/index.js
var require_methods = __commonJS({
  "C:/b/sand-release-cache/019fefbf-addb-4659-b7b0-14ab88f40d40/scratch/pnpm-virtual-store/adm-zip@0.5.16/node_modules/adm-zip/methods/index.js"(exports2) {
    exports2.Deflater = require_deflater();
    exports2.Inflater = require_inflater();
    exports2.ZipCrypto = require_zipcrypto();
  }
});

// C:/b/sand-release-cache/019fefbf-addb-4659-b7b0-14ab88f40d40/scratch/pnpm-virtual-store/adm-zip@0.5.16/node_modules/adm-zip/zipEntry.js
var require_zipEntry = __commonJS({
  "C:/b/sand-release-cache/019fefbf-addb-4659-b7b0-14ab88f40d40/scratch/pnpm-virtual-store/adm-zip@0.5.16/node_modules/adm-zip/zipEntry.js"(exports2, module2) {
    var Utils = require_util();
    var Headers = require_headers();
    var Constants = Utils.Constants;
    var Methods = require_methods();
    module2.exports = function(options, input) {
      var _centralHeader = new Headers.EntryHeader(), _entryName = Buffer.alloc(0), _comment = Buffer.alloc(0), _isDirectory = false, uncompressedData = null, _extra = Buffer.alloc(0), _extralocal = Buffer.alloc(0), _efs = true;
      const opts = options;
      const decoder = typeof opts.decoder === "object" ? opts.decoder : Utils.decoder;
      _efs = decoder.hasOwnProperty("efs") ? decoder.efs : false;
      function getCompressedDataFromZip() {
        if (!input || !(input instanceof Uint8Array)) {
          return Buffer.alloc(0);
        }
        _extralocal = _centralHeader.loadLocalHeaderFromBinary(input);
        return input.slice(_centralHeader.realDataOffset, _centralHeader.realDataOffset + _centralHeader.compressedSize);
      }
      function crc32OK(data) {
        if (!_centralHeader.flags_desc) {
          if (Utils.crc32(data) !== _centralHeader.localHeader.crc) {
            return false;
          }
        } else {
          const descriptor = {};
          const dataEndOffset = _centralHeader.realDataOffset + _centralHeader.compressedSize;
          if (input.readUInt32LE(dataEndOffset) == Constants.LOCSIG || input.readUInt32LE(dataEndOffset) == Constants.CENSIG) {
            throw Utils.Errors.DESCRIPTOR_NOT_EXIST();
          }
          if (input.readUInt32LE(dataEndOffset) == Constants.EXTSIG) {
            descriptor.crc = input.readUInt32LE(dataEndOffset + Constants.EXTCRC);
            descriptor.compressedSize = input.readUInt32LE(dataEndOffset + Constants.EXTSIZ);
            descriptor.size = input.readUInt32LE(dataEndOffset + Constants.EXTLEN);
          } else if (input.readUInt16LE(dataEndOffset + 12) === 19280) {
            descriptor.crc = input.readUInt32LE(dataEndOffset + Constants.EXTCRC - 4);
            descriptor.compressedSize = input.readUInt32LE(dataEndOffset + Constants.EXTSIZ - 4);
            descriptor.size = input.readUInt32LE(dataEndOffset + Constants.EXTLEN - 4);
          } else {
            throw Utils.Errors.DESCRIPTOR_UNKNOWN();
          }
          if (descriptor.compressedSize !== _centralHeader.compressedSize || descriptor.size !== _centralHeader.size || descriptor.crc !== _centralHeader.crc) {
            throw Utils.Errors.DESCRIPTOR_FAULTY();
          }
          if (Utils.crc32(data) !== descriptor.crc) {
            return false;
          }
        }
        return true;
      }
      function decompress(async, callback, pass) {
        if (typeof callback === "undefined" && typeof async === "string") {
          pass = async;
          async = void 0;
        }
        if (_isDirectory) {
          if (async && callback) {
            callback(Buffer.alloc(0), Utils.Errors.DIRECTORY_CONTENT_ERROR());
          }
          return Buffer.alloc(0);
        }
        var compressedData = getCompressedDataFromZip();
        if (compressedData.length === 0) {
          if (async && callback) callback(compressedData);
          return compressedData;
        }
        if (_centralHeader.encrypted) {
          if ("string" !== typeof pass && !Buffer.isBuffer(pass)) {
            throw Utils.Errors.INVALID_PASS_PARAM();
          }
          compressedData = Methods.ZipCrypto.decrypt(compressedData, _centralHeader, pass);
        }
        var data = Buffer.alloc(_centralHeader.size);
        switch (_centralHeader.method) {
          case Utils.Constants.STORED:
            compressedData.copy(data);
            if (!crc32OK(data)) {
              if (async && callback) callback(data, Utils.Errors.BAD_CRC());
              throw Utils.Errors.BAD_CRC();
            } else {
              if (async && callback) callback(data);
              return data;
            }
          case Utils.Constants.DEFLATED:
            var inflater = new Methods.Inflater(compressedData, _centralHeader.size);
            if (!async) {
              const result = inflater.inflate(data);
              result.copy(data, 0);
              if (!crc32OK(data)) {
                throw Utils.Errors.BAD_CRC(`"${decoder.decode(_entryName)}"`);
              }
              return data;
            } else {
              inflater.inflateAsync(function(result) {
                result.copy(result, 0);
                if (callback) {
                  if (!crc32OK(result)) {
                    callback(result, Utils.Errors.BAD_CRC());
                  } else {
                    callback(result);
                  }
                }
              });
            }
            break;
          default:
            if (async && callback) callback(Buffer.alloc(0), Utils.Errors.UNKNOWN_METHOD());
            throw Utils.Errors.UNKNOWN_METHOD();
        }
      }
      function compress(async, callback) {
        if ((!uncompressedData || !uncompressedData.length) && Buffer.isBuffer(input)) {
          if (async && callback) callback(getCompressedDataFromZip());
          return getCompressedDataFromZip();
        }
        if (uncompressedData.length && !_isDirectory) {
          var compressedData;
          switch (_centralHeader.method) {
            case Utils.Constants.STORED:
              _centralHeader.compressedSize = _centralHeader.size;
              compressedData = Buffer.alloc(uncompressedData.length);
              uncompressedData.copy(compressedData);
              if (async && callback) callback(compressedData);
              return compressedData;
            default:
            case Utils.Constants.DEFLATED:
              var deflater = new Methods.Deflater(uncompressedData);
              if (!async) {
                var deflated = deflater.deflate();
                _centralHeader.compressedSize = deflated.length;
                return deflated;
              } else {
                deflater.deflateAsync(function(data) {
                  compressedData = Buffer.alloc(data.length);
                  _centralHeader.compressedSize = data.length;
                  data.copy(compressedData);
                  callback && callback(compressedData);
                });
              }
              deflater = null;
              break;
          }
        } else if (async && callback) {
          callback(Buffer.alloc(0));
        } else {
          return Buffer.alloc(0);
        }
      }
      function readUInt64LE(buffer, offset) {
        return (buffer.readUInt32LE(offset + 4) << 4) + buffer.readUInt32LE(offset);
      }
      function parseExtra(data) {
        try {
          var offset = 0;
          var signature, size, part;
          while (offset + 4 < data.length) {
            signature = data.readUInt16LE(offset);
            offset += 2;
            size = data.readUInt16LE(offset);
            offset += 2;
            part = data.slice(offset, offset + size);
            offset += size;
            if (Constants.ID_ZIP64 === signature) {
              parseZip64ExtendedInformation(part);
            }
          }
        } catch (error) {
          throw Utils.Errors.EXTRA_FIELD_PARSE_ERROR();
        }
      }
      function parseZip64ExtendedInformation(data) {
        var size, compressedSize, offset, diskNumStart;
        if (data.length >= Constants.EF_ZIP64_SCOMP) {
          size = readUInt64LE(data, Constants.EF_ZIP64_SUNCOMP);
          if (_centralHeader.size === Constants.EF_ZIP64_OR_32) {
            _centralHeader.size = size;
          }
        }
        if (data.length >= Constants.EF_ZIP64_RHO) {
          compressedSize = readUInt64LE(data, Constants.EF_ZIP64_SCOMP);
          if (_centralHeader.compressedSize === Constants.EF_ZIP64_OR_32) {
            _centralHeader.compressedSize = compressedSize;
          }
        }
        if (data.length >= Constants.EF_ZIP64_DSN) {
          offset = readUInt64LE(data, Constants.EF_ZIP64_RHO);
          if (_centralHeader.offset === Constants.EF_ZIP64_OR_32) {
            _centralHeader.offset = offset;
          }
        }
        if (data.length >= Constants.EF_ZIP64_DSN + 4) {
          diskNumStart = data.readUInt32LE(Constants.EF_ZIP64_DSN);
          if (_centralHeader.diskNumStart === Constants.EF_ZIP64_OR_16) {
            _centralHeader.diskNumStart = diskNumStart;
          }
        }
      }
      return {
        get entryName() {
          return decoder.decode(_entryName);
        },
        get rawEntryName() {
          return _entryName;
        },
        set entryName(val) {
          _entryName = Utils.toBuffer(val, decoder.encode);
          var lastChar = _entryName[_entryName.length - 1];
          _isDirectory = lastChar === 47 || lastChar === 92;
          _centralHeader.fileNameLength = _entryName.length;
        },
        get efs() {
          if (typeof _efs === "function") {
            return _efs(this.entryName);
          } else {
            return _efs;
          }
        },
        get extra() {
          return _extra;
        },
        set extra(val) {
          _extra = val;
          _centralHeader.extraLength = val.length;
          parseExtra(val);
        },
        get comment() {
          return decoder.decode(_comment);
        },
        set comment(val) {
          _comment = Utils.toBuffer(val, decoder.encode);
          _centralHeader.commentLength = _comment.length;
          if (_comment.length > 65535) throw Utils.Errors.COMMENT_TOO_LONG();
        },
        get name() {
          var n = decoder.decode(_entryName);
          return _isDirectory ? n.substr(n.length - 1).split("/").pop() : n.split("/").pop();
        },
        get isDirectory() {
          return _isDirectory;
        },
        getCompressedData: function() {
          return compress(false, null);
        },
        getCompressedDataAsync: function(callback) {
          compress(true, callback);
        },
        setData: function(value) {
          uncompressedData = Utils.toBuffer(value, Utils.decoder.encode);
          if (!_isDirectory && uncompressedData.length) {
            _centralHeader.size = uncompressedData.length;
            _centralHeader.method = Utils.Constants.DEFLATED;
            _centralHeader.crc = Utils.crc32(value);
            _centralHeader.changed = true;
          } else {
            _centralHeader.method = Utils.Constants.STORED;
          }
        },
        getData: function(pass) {
          if (_centralHeader.changed) {
            return uncompressedData;
          } else {
            return decompress(false, null, pass);
          }
        },
        getDataAsync: function(callback, pass) {
          if (_centralHeader.changed) {
            callback(uncompressedData);
          } else {
            decompress(true, callback, pass);
          }
        },
        set attr(attr) {
          _centralHeader.attr = attr;
        },
        get attr() {
          return _centralHeader.attr;
        },
        set header(data) {
          _centralHeader.loadFromBinary(data);
        },
        get header() {
          return _centralHeader;
        },
        packCentralHeader: function() {
          _centralHeader.flags_efs = this.efs;
          _centralHeader.extraLength = _extra.length;
          var header = _centralHeader.centralHeaderToBinary();
          var addpos = Utils.Constants.CENHDR;
          _entryName.copy(header, addpos);
          addpos += _entryName.length;
          _extra.copy(header, addpos);
          addpos += _centralHeader.extraLength;
          _comment.copy(header, addpos);
          return header;
        },
        packLocalHeader: function() {
          let addpos = 0;
          _centralHeader.flags_efs = this.efs;
          _centralHeader.extraLocalLength = _extralocal.length;
          const localHeaderBuf = _centralHeader.localHeaderToBinary();
          const localHeader = Buffer.alloc(localHeaderBuf.length + _entryName.length + _centralHeader.extraLocalLength);
          localHeaderBuf.copy(localHeader, addpos);
          addpos += localHeaderBuf.length;
          _entryName.copy(localHeader, addpos);
          addpos += _entryName.length;
          _extralocal.copy(localHeader, addpos);
          addpos += _extralocal.length;
          return localHeader;
        },
        toJSON: function() {
          const bytes = function(nr) {
            return "<" + (nr && nr.length + " bytes buffer" || "null") + ">";
          };
          return {
            entryName: this.entryName,
            name: this.name,
            comment: this.comment,
            isDirectory: this.isDirectory,
            header: _centralHeader.toJSON(),
            compressedData: bytes(input),
            data: bytes(uncompressedData)
          };
        },
        toString: function() {
          return JSON.stringify(this.toJSON(), null, "	");
        }
      };
    };
  }
});

// C:/b/sand-release-cache/019fefbf-addb-4659-b7b0-14ab88f40d40/scratch/pnpm-virtual-store/adm-zip@0.5.16/node_modules/adm-zip/zipFile.js
var require_zipFile = __commonJS({
  "C:/b/sand-release-cache/019fefbf-addb-4659-b7b0-14ab88f40d40/scratch/pnpm-virtual-store/adm-zip@0.5.16/node_modules/adm-zip/zipFile.js"(exports2, module2) {
    var ZipEntry = require_zipEntry();
    var Headers = require_headers();
    var Utils = require_util();
    module2.exports = function(inBuffer, options) {
      var entryList = [], entryTable = {}, _comment = Buffer.alloc(0), mainHeader = new Headers.MainHeader(), loadedEntries = false;
      var password = null;
      const temporary = /* @__PURE__ */ new Set();
      const opts = options;
      const { noSort, decoder } = opts;
      if (inBuffer) {
        readMainHeader(opts.readEntries);
      } else {
        loadedEntries = true;
      }
      function makeTemporaryFolders() {
        const foldersList = /* @__PURE__ */ new Set();
        for (const elem of Object.keys(entryTable)) {
          const elements = elem.split("/");
          elements.pop();
          if (!elements.length) continue;
          for (let i = 0; i < elements.length; i++) {
            const sub = elements.slice(0, i + 1).join("/") + "/";
            foldersList.add(sub);
          }
        }
        for (const elem of foldersList) {
          if (!(elem in entryTable)) {
            const tempfolder = new ZipEntry(opts);
            tempfolder.entryName = elem;
            tempfolder.attr = 16;
            tempfolder.temporary = true;
            entryList.push(tempfolder);
            entryTable[tempfolder.entryName] = tempfolder;
            temporary.add(tempfolder);
          }
        }
      }
      function readEntries() {
        loadedEntries = true;
        entryTable = {};
        if (mainHeader.diskEntries > (inBuffer.length - mainHeader.offset) / Utils.Constants.CENHDR) {
          throw Utils.Errors.DISK_ENTRY_TOO_LARGE();
        }
        entryList = new Array(mainHeader.diskEntries);
        var index = mainHeader.offset;
        for (var i = 0; i < entryList.length; i++) {
          var tmp = index, entry = new ZipEntry(opts, inBuffer);
          entry.header = inBuffer.slice(tmp, tmp += Utils.Constants.CENHDR);
          entry.entryName = inBuffer.slice(tmp, tmp += entry.header.fileNameLength);
          if (entry.header.extraLength) {
            entry.extra = inBuffer.slice(tmp, tmp += entry.header.extraLength);
          }
          if (entry.header.commentLength) entry.comment = inBuffer.slice(tmp, tmp + entry.header.commentLength);
          index += entry.header.centralHeaderSize;
          entryList[i] = entry;
          entryTable[entry.entryName] = entry;
        }
        temporary.clear();
        makeTemporaryFolders();
      }
      function readMainHeader(readNow) {
        var i = inBuffer.length - Utils.Constants.ENDHDR, max = Math.max(0, i - 65535), n = max, endStart = inBuffer.length, endOffset = -1, commentEnd = 0;
        const trailingSpace = typeof opts.trailingSpace === "boolean" ? opts.trailingSpace : false;
        if (trailingSpace) max = 0;
        for (i; i >= n; i--) {
          if (inBuffer[i] !== 80) continue;
          if (inBuffer.readUInt32LE(i) === Utils.Constants.ENDSIG) {
            endOffset = i;
            commentEnd = i;
            endStart = i + Utils.Constants.ENDHDR;
            n = i - Utils.Constants.END64HDR;
            continue;
          }
          if (inBuffer.readUInt32LE(i) === Utils.Constants.END64SIG) {
            n = max;
            continue;
          }
          if (inBuffer.readUInt32LE(i) === Utils.Constants.ZIP64SIG) {
            endOffset = i;
            endStart = i + Utils.readBigUInt64LE(inBuffer, i + Utils.Constants.ZIP64SIZE) + Utils.Constants.ZIP64LEAD;
            break;
          }
        }
        if (endOffset == -1) throw Utils.Errors.INVALID_FORMAT();
        mainHeader.loadFromBinary(inBuffer.slice(endOffset, endStart));
        if (mainHeader.commentLength) {
          _comment = inBuffer.slice(commentEnd + Utils.Constants.ENDHDR);
        }
        if (readNow) readEntries();
      }
      function sortEntries() {
        if (entryList.length > 1 && !noSort) {
          entryList.sort((a, b) => a.entryName.toLowerCase().localeCompare(b.entryName.toLowerCase()));
        }
      }
      return {
        /**
         * Returns an array of ZipEntry objects existent in the current opened archive
         * @return Array
         */
        get entries() {
          if (!loadedEntries) {
            readEntries();
          }
          return entryList.filter((e) => !temporary.has(e));
        },
        /**
         * Archive comment
         * @return {String}
         */
        get comment() {
          return decoder.decode(_comment);
        },
        set comment(val) {
          _comment = Utils.toBuffer(val, decoder.encode);
          mainHeader.commentLength = _comment.length;
        },
        getEntryCount: function() {
          if (!loadedEntries) {
            return mainHeader.diskEntries;
          }
          return entryList.length;
        },
        forEach: function(callback) {
          this.entries.forEach(callback);
        },
        /**
         * Returns a reference to the entry with the given name or null if entry is inexistent
         *
         * @param entryName
         * @return ZipEntry
         */
        getEntry: function(entryName) {
          if (!loadedEntries) {
            readEntries();
          }
          return entryTable[entryName] || null;
        },
        /**
         * Adds the given entry to the entry list
         *
         * @param entry
         */
        setEntry: function(entry) {
          if (!loadedEntries) {
            readEntries();
          }
          entryList.push(entry);
          entryTable[entry.entryName] = entry;
          mainHeader.totalEntries = entryList.length;
        },
        /**
         * Removes the file with the given name from the entry list.
         *
         * If the entry is a directory, then all nested files and directories will be removed
         * @param entryName
         * @returns {void}
         */
        deleteFile: function(entryName, withsubfolders = true) {
          if (!loadedEntries) {
            readEntries();
          }
          const entry = entryTable[entryName];
          const list = this.getEntryChildren(entry, withsubfolders).map((child) => child.entryName);
          list.forEach(this.deleteEntry);
        },
        /**
         * Removes the entry with the given name from the entry list.
         *
         * @param {string} entryName
         * @returns {void}
         */
        deleteEntry: function(entryName) {
          if (!loadedEntries) {
            readEntries();
          }
          const entry = entryTable[entryName];
          const index = entryList.indexOf(entry);
          if (index >= 0) {
            entryList.splice(index, 1);
            delete entryTable[entryName];
            mainHeader.totalEntries = entryList.length;
          }
        },
        /**
         *  Iterates and returns all nested files and directories of the given entry
         *
         * @param entry
         * @return Array
         */
        getEntryChildren: function(entry, subfolders = true) {
          if (!loadedEntries) {
            readEntries();
          }
          if (typeof entry === "object") {
            if (entry.isDirectory && subfolders) {
              const list = [];
              const name = entry.entryName;
              for (const zipEntry of entryList) {
                if (zipEntry.entryName.startsWith(name)) {
                  list.push(zipEntry);
                }
              }
              return list;
            } else {
              return [entry];
            }
          }
          return [];
        },
        /**
         *  How many child elements entry has
         *
         * @param {ZipEntry} entry
         * @return {integer}
         */
        getChildCount: function(entry) {
          if (entry && entry.isDirectory) {
            const list = this.getEntryChildren(entry);
            return list.includes(entry) ? list.length - 1 : list.length;
          }
          return 0;
        },
        /**
         * Returns the zip file
         *
         * @return Buffer
         */
        compressToBuffer: function() {
          if (!loadedEntries) {
            readEntries();
          }
          sortEntries();
          const dataBlock = [];
          const headerBlocks = [];
          let totalSize = 0;
          let dindex = 0;
          mainHeader.size = 0;
          mainHeader.offset = 0;
          let totalEntries = 0;
          for (const entry of this.entries) {
            const compressedData = entry.getCompressedData();
            entry.header.offset = dindex;
            const localHeader = entry.packLocalHeader();
            const dataLength = localHeader.length + compressedData.length;
            dindex += dataLength;
            dataBlock.push(localHeader);
            dataBlock.push(compressedData);
            const centralHeader = entry.packCentralHeader();
            headerBlocks.push(centralHeader);
            mainHeader.size += centralHeader.length;
            totalSize += dataLength + centralHeader.length;
            totalEntries++;
          }
          totalSize += mainHeader.mainHeaderSize;
          mainHeader.offset = dindex;
          mainHeader.totalEntries = totalEntries;
          dindex = 0;
          const outBuffer = Buffer.alloc(totalSize);
          for (const content of dataBlock) {
            content.copy(outBuffer, dindex);
            dindex += content.length;
          }
          for (const content of headerBlocks) {
            content.copy(outBuffer, dindex);
            dindex += content.length;
          }
          const mh = mainHeader.toBinary();
          if (_comment) {
            _comment.copy(mh, Utils.Constants.ENDHDR);
          }
          mh.copy(outBuffer, dindex);
          inBuffer = outBuffer;
          loadedEntries = false;
          return outBuffer;
        },
        toAsyncBuffer: function(onSuccess, onFail, onItemStart, onItemEnd) {
          try {
            if (!loadedEntries) {
              readEntries();
            }
            sortEntries();
            const dataBlock = [];
            const centralHeaders = [];
            let totalSize = 0;
            let dindex = 0;
            let totalEntries = 0;
            mainHeader.size = 0;
            mainHeader.offset = 0;
            const compress2Buffer = function(entryLists) {
              if (entryLists.length > 0) {
                const entry = entryLists.shift();
                const name = entry.entryName + entry.extra.toString();
                if (onItemStart) onItemStart(name);
                entry.getCompressedDataAsync(function(compressedData) {
                  if (onItemEnd) onItemEnd(name);
                  entry.header.offset = dindex;
                  const localHeader = entry.packLocalHeader();
                  const dataLength = localHeader.length + compressedData.length;
                  dindex += dataLength;
                  dataBlock.push(localHeader);
                  dataBlock.push(compressedData);
                  const centalHeader = entry.packCentralHeader();
                  centralHeaders.push(centalHeader);
                  mainHeader.size += centalHeader.length;
                  totalSize += dataLength + centalHeader.length;
                  totalEntries++;
                  compress2Buffer(entryLists);
                });
              } else {
                totalSize += mainHeader.mainHeaderSize;
                mainHeader.offset = dindex;
                mainHeader.totalEntries = totalEntries;
                dindex = 0;
                const outBuffer = Buffer.alloc(totalSize);
                dataBlock.forEach(function(content) {
                  content.copy(outBuffer, dindex);
                  dindex += content.length;
                });
                centralHeaders.forEach(function(content) {
                  content.copy(outBuffer, dindex);
                  dindex += content.length;
                });
                const mh = mainHeader.toBinary();
                if (_comment) {
                  _comment.copy(mh, Utils.Constants.ENDHDR);
                }
                mh.copy(outBuffer, dindex);
                inBuffer = outBuffer;
                loadedEntries = false;
                onSuccess(outBuffer);
              }
            };
            compress2Buffer(Array.from(this.entries));
          } catch (e) {
            onFail(e);
          }
        }
      };
    };
  }
});

// C:/b/sand-release-cache/019fefbf-addb-4659-b7b0-14ab88f40d40/scratch/pnpm-virtual-store/adm-zip@0.5.16/node_modules/adm-zip/adm-zip.js
var require_adm_zip = __commonJS({
  "C:/b/sand-release-cache/019fefbf-addb-4659-b7b0-14ab88f40d40/scratch/pnpm-virtual-store/adm-zip@0.5.16/node_modules/adm-zip/adm-zip.js"(exports2, module2) {
    var Utils = require_util();
    var pth = require("path");
    var ZipEntry = require_zipEntry();
    var ZipFile = require_zipFile();
    var get_Bool = (...val) => Utils.findLast(val, (c) => typeof c === "boolean");
    var get_Str = (...val) => Utils.findLast(val, (c) => typeof c === "string");
    var get_Fun = (...val) => Utils.findLast(val, (c) => typeof c === "function");
    var defaultOptions = {
      // option "noSort" : if true it disables files sorting
      noSort: false,
      // read entries during load (initial loading may be slower)
      readEntries: false,
      // default method is none
      method: Utils.Constants.NONE,
      // file system
      fs: null
    };
    module2.exports = function(input, options) {
      let inBuffer = null;
      const opts = Object.assign(/* @__PURE__ */ Object.create(null), defaultOptions);
      if (input && "object" === typeof input) {
        if (!(input instanceof Uint8Array)) {
          Object.assign(opts, input);
          input = opts.input ? opts.input : void 0;
          if (opts.input) delete opts.input;
        }
        if (Buffer.isBuffer(input)) {
          inBuffer = input;
          opts.method = Utils.Constants.BUFFER;
          input = void 0;
        }
      }
      Object.assign(opts, options);
      const filetools = new Utils(opts);
      if (typeof opts.decoder !== "object" || typeof opts.decoder.encode !== "function" || typeof opts.decoder.decode !== "function") {
        opts.decoder = Utils.decoder;
      }
      if (input && "string" === typeof input) {
        if (filetools.fs.existsSync(input)) {
          opts.method = Utils.Constants.FILE;
          opts.filename = input;
          inBuffer = filetools.fs.readFileSync(input);
        } else {
          throw Utils.Errors.INVALID_FILENAME();
        }
      }
      const _zip = new ZipFile(inBuffer, opts);
      const { canonical, sanitize, zipnamefix } = Utils;
      function getEntry(entry) {
        if (entry && _zip) {
          var item;
          if (typeof entry === "string") item = _zip.getEntry(pth.posix.normalize(entry));
          if (typeof entry === "object" && typeof entry.entryName !== "undefined" && typeof entry.header !== "undefined") item = _zip.getEntry(entry.entryName);
          if (item) {
            return item;
          }
        }
        return null;
      }
      function fixPath(zipPath) {
        const { join: join4, normalize, sep } = pth.posix;
        return join4(".", normalize(sep + zipPath.split("\\").join(sep) + sep));
      }
      function filenameFilter(filterfn) {
        if (filterfn instanceof RegExp) {
          return /* @__PURE__ */ (function(rx) {
            return function(filename) {
              return rx.test(filename);
            };
          })(filterfn);
        } else if ("function" !== typeof filterfn) {
          return () => true;
        }
        return filterfn;
      }
      const relativePath = (local, entry) => {
        let lastChar = entry.slice(-1);
        lastChar = lastChar === filetools.sep ? filetools.sep : "";
        return pth.relative(local, entry) + lastChar;
      };
      return {
        /**
         * Extracts the given entry from the archive and returns the content as a Buffer object
         * @param {ZipEntry|string} entry ZipEntry object or String with the full path of the entry
         * @param {Buffer|string} [pass] - password
         * @return Buffer or Null in case of error
         */
        readFile: function(entry, pass) {
          var item = getEntry(entry);
          return item && item.getData(pass) || null;
        },
        /**
         * Returns how many child elements has on entry (directories) on files it is always 0
         * @param {ZipEntry|string} entry ZipEntry object or String with the full path of the entry
         * @returns {integer}
         */
        childCount: function(entry) {
          const item = getEntry(entry);
          if (item) {
            return _zip.getChildCount(item);
          }
        },
        /**
         * Asynchronous readFile
         * @param {ZipEntry|string} entry ZipEntry object or String with the full path of the entry
         * @param {callback} callback
         *
         * @return Buffer or Null in case of error
         */
        readFileAsync: function(entry, callback) {
          var item = getEntry(entry);
          if (item) {
            item.getDataAsync(callback);
          } else {
            callback(null, "getEntry failed for:" + entry);
          }
        },
        /**
         * Extracts the given entry from the archive and returns the content as plain text in the given encoding
         * @param {ZipEntry|string} entry - ZipEntry object or String with the full path of the entry
         * @param {string} encoding - Optional. If no encoding is specified utf8 is used
         *
         * @return String
         */
        readAsText: function(entry, encoding) {
          var item = getEntry(entry);
          if (item) {
            var data = item.getData();
            if (data && data.length) {
              return data.toString(encoding || "utf8");
            }
          }
          return "";
        },
        /**
         * Asynchronous readAsText
         * @param {ZipEntry|string} entry ZipEntry object or String with the full path of the entry
         * @param {callback} callback
         * @param {string} [encoding] - Optional. If no encoding is specified utf8 is used
         *
         * @return String
         */
        readAsTextAsync: function(entry, callback, encoding) {
          var item = getEntry(entry);
          if (item) {
            item.getDataAsync(function(data, err) {
              if (err) {
                callback(data, err);
                return;
              }
              if (data && data.length) {
                callback(data.toString(encoding || "utf8"));
              } else {
                callback("");
              }
            });
          } else {
            callback("");
          }
        },
        /**
         * Remove the entry from the file or the entry and all it's nested directories and files if the given entry is a directory
         *
         * @param {ZipEntry|string} entry
         * @returns {void}
         */
        deleteFile: function(entry, withsubfolders = true) {
          var item = getEntry(entry);
          if (item) {
            _zip.deleteFile(item.entryName, withsubfolders);
          }
        },
        /**
         * Remove the entry from the file or directory without affecting any nested entries
         *
         * @param {ZipEntry|string} entry
         * @returns {void}
         */
        deleteEntry: function(entry) {
          var item = getEntry(entry);
          if (item) {
            _zip.deleteEntry(item.entryName);
          }
        },
        /**
         * Adds a comment to the zip. The zip must be rewritten after adding the comment.
         *
         * @param {string} comment
         */
        addZipComment: function(comment) {
          _zip.comment = comment;
        },
        /**
         * Returns the zip comment
         *
         * @return String
         */
        getZipComment: function() {
          return _zip.comment || "";
        },
        /**
         * Adds a comment to a specified zipEntry. The zip must be rewritten after adding the comment
         * The comment cannot exceed 65535 characters in length
         *
         * @param {ZipEntry} entry
         * @param {string} comment
         */
        addZipEntryComment: function(entry, comment) {
          var item = getEntry(entry);
          if (item) {
            item.comment = comment;
          }
        },
        /**
         * Returns the comment of the specified entry
         *
         * @param {ZipEntry} entry
         * @return String
         */
        getZipEntryComment: function(entry) {
          var item = getEntry(entry);
          if (item) {
            return item.comment || "";
          }
          return "";
        },
        /**
         * Updates the content of an existing entry inside the archive. The zip must be rewritten after updating the content
         *
         * @param {ZipEntry} entry
         * @param {Buffer} content
         */
        updateFile: function(entry, content) {
          var item = getEntry(entry);
          if (item) {
            item.setData(content);
          }
        },
        /**
         * Adds a file from the disk to the archive
         *
         * @param {string} localPath File to add to zip
         * @param {string} [zipPath] Optional path inside the zip
         * @param {string} [zipName] Optional name for the file
         * @param {string} [comment] Optional file comment
         */
        addLocalFile: function(localPath2, zipPath, zipName, comment) {
          if (filetools.fs.existsSync(localPath2)) {
            zipPath = zipPath ? fixPath(zipPath) : "";
            const p = pth.win32.basename(pth.win32.normalize(localPath2));
            zipPath += zipName ? zipName : p;
            const _attr = filetools.fs.statSync(localPath2);
            const data = _attr.isFile() ? filetools.fs.readFileSync(localPath2) : Buffer.alloc(0);
            if (_attr.isDirectory()) zipPath += filetools.sep;
            this.addFile(zipPath, data, comment, _attr);
          } else {
            throw Utils.Errors.FILE_NOT_FOUND(localPath2);
          }
        },
        /**
         * Callback for showing if everything was done.
         *
         * @callback doneCallback
         * @param {Error} err - Error object
         * @param {boolean} done - was request fully completed
         */
        /**
         * Adds a file from the disk to the archive
         *
         * @param {(object|string)} options - options object, if it is string it us used as localPath.
         * @param {string} options.localPath - Local path to the file.
         * @param {string} [options.comment] - Optional file comment.
         * @param {string} [options.zipPath] - Optional path inside the zip
         * @param {string} [options.zipName] - Optional name for the file
         * @param {doneCallback} callback - The callback that handles the response.
         */
        addLocalFileAsync: function(options2, callback) {
          options2 = typeof options2 === "object" ? options2 : { localPath: options2 };
          const localPath2 = pth.resolve(options2.localPath);
          const { comment } = options2;
          let { zipPath, zipName } = options2;
          const self = this;
          filetools.fs.stat(localPath2, function(err, stats) {
            if (err) return callback(err, false);
            zipPath = zipPath ? fixPath(zipPath) : "";
            const p = pth.win32.basename(pth.win32.normalize(localPath2));
            zipPath += zipName ? zipName : p;
            if (stats.isFile()) {
              filetools.fs.readFile(localPath2, function(err2, data) {
                if (err2) return callback(err2, false);
                self.addFile(zipPath, data, comment, stats);
                return setImmediate(callback, void 0, true);
              });
            } else if (stats.isDirectory()) {
              zipPath += filetools.sep;
              self.addFile(zipPath, Buffer.alloc(0), comment, stats);
              return setImmediate(callback, void 0, true);
            }
          });
        },
        /**
         * Adds a local directory and all its nested files and directories to the archive
         *
         * @param {string} localPath - local path to the folder
         * @param {string} [zipPath] - optional path inside zip
         * @param {(RegExp|function)} [filter] - optional RegExp or Function if files match will be included.
         */
        addLocalFolder: function(localPath2, zipPath, filter) {
          filter = filenameFilter(filter);
          zipPath = zipPath ? fixPath(zipPath) : "";
          localPath2 = pth.normalize(localPath2);
          if (filetools.fs.existsSync(localPath2)) {
            const items = filetools.findFiles(localPath2);
            const self = this;
            if (items.length) {
              for (const filepath of items) {
                const p = pth.join(zipPath, relativePath(localPath2, filepath));
                if (filter(p)) {
                  self.addLocalFile(filepath, pth.dirname(p));
                }
              }
            }
          } else {
            throw Utils.Errors.FILE_NOT_FOUND(localPath2);
          }
        },
        /**
         * Asynchronous addLocalFolder
         * @param {string} localPath
         * @param {callback} callback
         * @param {string} [zipPath] optional path inside zip
         * @param {RegExp|function} [filter] optional RegExp or Function if files match will
         *               be included.
         */
        addLocalFolderAsync: function(localPath2, callback, zipPath, filter) {
          filter = filenameFilter(filter);
          zipPath = zipPath ? fixPath(zipPath) : "";
          localPath2 = pth.normalize(localPath2);
          var self = this;
          filetools.fs.open(localPath2, "r", function(err) {
            if (err && err.code === "ENOENT") {
              callback(void 0, Utils.Errors.FILE_NOT_FOUND(localPath2));
            } else if (err) {
              callback(void 0, err);
            } else {
              var items = filetools.findFiles(localPath2);
              var i = -1;
              var next = function() {
                i += 1;
                if (i < items.length) {
                  var filepath = items[i];
                  var p = relativePath(localPath2, filepath).split("\\").join("/");
                  p = p.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7E]/g, "");
                  if (filter(p)) {
                    filetools.fs.stat(filepath, function(er0, stats) {
                      if (er0) callback(void 0, er0);
                      if (stats.isFile()) {
                        filetools.fs.readFile(filepath, function(er1, data) {
                          if (er1) {
                            callback(void 0, er1);
                          } else {
                            self.addFile(zipPath + p, data, "", stats);
                            next();
                          }
                        });
                      } else {
                        self.addFile(zipPath + p + "/", Buffer.alloc(0), "", stats);
                        next();
                      }
                    });
                  } else {
                    process.nextTick(() => {
                      next();
                    });
                  }
                } else {
                  callback(true, void 0);
                }
              };
              next();
            }
          });
        },
        /**
         * Adds a local directory and all its nested files and directories to the archive
         *
         * @param {object | string} options - options object, if it is string it us used as localPath.
         * @param {string} options.localPath - Local path to the folder.
         * @param {string} [options.zipPath] - optional path inside zip.
         * @param {RegExp|function} [options.filter] - optional RegExp or Function if files match will be included.
         * @param {function|string} [options.namefix] - optional function to help fix filename
         * @param {doneCallback} callback - The callback that handles the response.
         *
         */
        addLocalFolderAsync2: function(options2, callback) {
          const self = this;
          options2 = typeof options2 === "object" ? options2 : { localPath: options2 };
          localPath = pth.resolve(fixPath(options2.localPath));
          let { zipPath, filter, namefix } = options2;
          if (filter instanceof RegExp) {
            filter = /* @__PURE__ */ (function(rx) {
              return function(filename) {
                return rx.test(filename);
              };
            })(filter);
          } else if ("function" !== typeof filter) {
            filter = function() {
              return true;
            };
          }
          zipPath = zipPath ? fixPath(zipPath) : "";
          if (namefix == "latin1") {
            namefix = (str) => str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7E]/g, "");
          }
          if (typeof namefix !== "function") namefix = (str) => str;
          const relPathFix = (entry) => pth.join(zipPath, namefix(relativePath(localPath, entry)));
          const fileNameFix = (entry) => pth.win32.basename(pth.win32.normalize(namefix(entry)));
          filetools.fs.open(localPath, "r", function(err) {
            if (err && err.code === "ENOENT") {
              callback(void 0, Utils.Errors.FILE_NOT_FOUND(localPath));
            } else if (err) {
              callback(void 0, err);
            } else {
              filetools.findFilesAsync(localPath, function(err2, fileEntries) {
                if (err2) return callback(err2);
                fileEntries = fileEntries.filter((dir) => filter(relPathFix(dir)));
                if (!fileEntries.length) callback(void 0, false);
                setImmediate(
                  fileEntries.reverse().reduce(function(next, entry) {
                    return function(err3, done) {
                      if (err3 || done === false) return setImmediate(next, err3, false);
                      self.addLocalFileAsync(
                        {
                          localPath: entry,
                          zipPath: pth.dirname(relPathFix(entry)),
                          zipName: fileNameFix(entry)
                        },
                        next
                      );
                    };
                  }, callback)
                );
              });
            }
          });
        },
        /**
         * Adds a local directory and all its nested files and directories to the archive
         *
         * @param {string} localPath - path where files will be extracted
         * @param {object} props - optional properties
         * @param {string} [props.zipPath] - optional path inside zip
         * @param {RegExp|function} [props.filter] - optional RegExp or Function if files match will be included.
         * @param {function|string} [props.namefix] - optional function to help fix filename
         */
        addLocalFolderPromise: function(localPath2, props) {
          return new Promise((resolve2, reject) => {
            this.addLocalFolderAsync2(Object.assign({ localPath: localPath2 }, props), (err, done) => {
              if (err) reject(err);
              if (done) resolve2(this);
            });
          });
        },
        /**
         * Allows you to create a entry (file or directory) in the zip file.
         * If you want to create a directory the entryName must end in / and a null buffer should be provided.
         * Comment and attributes are optional
         *
         * @param {string} entryName
         * @param {Buffer | string} content - file content as buffer or utf8 coded string
         * @param {string} [comment] - file comment
         * @param {number | object} [attr] - number as unix file permissions, object as filesystem Stats object
         */
        addFile: function(entryName, content, comment, attr) {
          entryName = zipnamefix(entryName);
          let entry = getEntry(entryName);
          const update = entry != null;
          if (!update) {
            entry = new ZipEntry(opts);
            entry.entryName = entryName;
          }
          entry.comment = comment || "";
          const isStat = "object" === typeof attr && attr instanceof filetools.fs.Stats;
          if (isStat) {
            entry.header.time = attr.mtime;
          }
          var fileattr = entry.isDirectory ? 16 : 0;
          let unix = entry.isDirectory ? 16384 : 32768;
          if (isStat) {
            unix |= 4095 & attr.mode;
          } else if ("number" === typeof attr) {
            unix |= 4095 & attr;
          } else {
            unix |= entry.isDirectory ? 493 : 420;
          }
          fileattr = (fileattr | unix << 16) >>> 0;
          entry.attr = fileattr;
          entry.setData(content);
          if (!update) _zip.setEntry(entry);
          return entry;
        },
        /**
         * Returns an array of ZipEntry objects representing the files and folders inside the archive
         *
         * @param {string} [password]
         * @returns Array
         */
        getEntries: function(password) {
          _zip.password = password;
          return _zip ? _zip.entries : [];
        },
        /**
         * Returns a ZipEntry object representing the file or folder specified by ``name``.
         *
         * @param {string} name
         * @return ZipEntry
         */
        getEntry: function(name) {
          return getEntry(name);
        },
        getEntryCount: function() {
          return _zip.getEntryCount();
        },
        forEach: function(callback) {
          return _zip.forEach(callback);
        },
        /**
         * Extracts the given entry to the given targetPath
         * If the entry is a directory inside the archive, the entire directory and it's subdirectories will be extracted
         *
         * @param {string|ZipEntry} entry - ZipEntry object or String with the full path of the entry
         * @param {string} targetPath - Target folder where to write the file
         * @param {boolean} [maintainEntryPath=true] - If maintainEntryPath is true and the entry is inside a folder, the entry folder will be created in targetPath as well. Default is TRUE
         * @param {boolean} [overwrite=false] - If the file already exists at the target path, the file will be overwriten if this is true.
         * @param {boolean} [keepOriginalPermission=false] - The file will be set as the permission from the entry if this is true.
         * @param {string} [outFileName] - String If set will override the filename of the extracted file (Only works if the entry is a file)
         *
         * @return Boolean
         */
        extractEntryTo: function(entry, targetPath, maintainEntryPath, overwrite, keepOriginalPermission, outFileName) {
          overwrite = get_Bool(false, overwrite);
          keepOriginalPermission = get_Bool(false, keepOriginalPermission);
          maintainEntryPath = get_Bool(true, maintainEntryPath);
          outFileName = get_Str(keepOriginalPermission, outFileName);
          var item = getEntry(entry);
          if (!item) {
            throw Utils.Errors.NO_ENTRY();
          }
          var entryName = canonical(item.entryName);
          var target = sanitize(targetPath, outFileName && !item.isDirectory ? outFileName : maintainEntryPath ? entryName : pth.basename(entryName));
          if (item.isDirectory) {
            var children = _zip.getEntryChildren(item);
            children.forEach(function(child) {
              if (child.isDirectory) return;
              var content2 = child.getData();
              if (!content2) {
                throw Utils.Errors.CANT_EXTRACT_FILE();
              }
              var name = canonical(child.entryName);
              var childName = sanitize(targetPath, maintainEntryPath ? name : pth.basename(name));
              const fileAttr2 = keepOriginalPermission ? child.header.fileAttr : void 0;
              filetools.writeFileTo(childName, content2, overwrite, fileAttr2);
            });
            return true;
          }
          var content = item.getData(_zip.password);
          if (!content) throw Utils.Errors.CANT_EXTRACT_FILE();
          if (filetools.fs.existsSync(target) && !overwrite) {
            throw Utils.Errors.CANT_OVERRIDE();
          }
          const fileAttr = keepOriginalPermission ? entry.header.fileAttr : void 0;
          filetools.writeFileTo(target, content, overwrite, fileAttr);
          return true;
        },
        /**
         * Test the archive
         * @param {string} [pass]
         */
        test: function(pass) {
          if (!_zip) {
            return false;
          }
          for (var entry in _zip.entries) {
            try {
              if (entry.isDirectory) {
                continue;
              }
              var content = _zip.entries[entry].getData(pass);
              if (!content) {
                return false;
              }
            } catch (err) {
              return false;
            }
          }
          return true;
        },
        /**
         * Extracts the entire archive to the given location
         *
         * @param {string} targetPath Target location
         * @param {boolean} [overwrite=false] If the file already exists at the target path, the file will be overwriten if this is true.
         *                  Default is FALSE
         * @param {boolean} [keepOriginalPermission=false] The file will be set as the permission from the entry if this is true.
         *                  Default is FALSE
         * @param {string|Buffer} [pass] password
         */
        extractAllTo: function(targetPath, overwrite, keepOriginalPermission, pass) {
          keepOriginalPermission = get_Bool(false, keepOriginalPermission);
          pass = get_Str(keepOriginalPermission, pass);
          overwrite = get_Bool(false, overwrite);
          if (!_zip) throw Utils.Errors.NO_ZIP();
          _zip.entries.forEach(function(entry) {
            var entryName = sanitize(targetPath, canonical(entry.entryName));
            if (entry.isDirectory) {
              filetools.makeDir(entryName);
              return;
            }
            var content = entry.getData(pass);
            if (!content) {
              throw Utils.Errors.CANT_EXTRACT_FILE();
            }
            const fileAttr = keepOriginalPermission ? entry.header.fileAttr : void 0;
            filetools.writeFileTo(entryName, content, overwrite, fileAttr);
            try {
              filetools.fs.utimesSync(entryName, entry.header.time, entry.header.time);
            } catch (err) {
              throw Utils.Errors.CANT_EXTRACT_FILE();
            }
          });
        },
        /**
         * Asynchronous extractAllTo
         *
         * @param {string} targetPath Target location
         * @param {boolean} [overwrite=false] If the file already exists at the target path, the file will be overwriten if this is true.
         *                  Default is FALSE
         * @param {boolean} [keepOriginalPermission=false] The file will be set as the permission from the entry if this is true.
         *                  Default is FALSE
         * @param {function} callback The callback will be executed when all entries are extracted successfully or any error is thrown.
         */
        extractAllToAsync: function(targetPath, overwrite, keepOriginalPermission, callback) {
          callback = get_Fun(overwrite, keepOriginalPermission, callback);
          keepOriginalPermission = get_Bool(false, keepOriginalPermission);
          overwrite = get_Bool(false, overwrite);
          if (!callback) {
            return new Promise((resolve2, reject) => {
              this.extractAllToAsync(targetPath, overwrite, keepOriginalPermission, function(err) {
                if (err) {
                  reject(err);
                } else {
                  resolve2(this);
                }
              });
            });
          }
          if (!_zip) {
            callback(Utils.Errors.NO_ZIP());
            return;
          }
          targetPath = pth.resolve(targetPath);
          const getPath = (entry) => sanitize(targetPath, pth.normalize(canonical(entry.entryName)));
          const getError = (msg, file) => new Error(msg + ': "' + file + '"');
          const dirEntries = [];
          const fileEntries = [];
          _zip.entries.forEach((e) => {
            if (e.isDirectory) {
              dirEntries.push(e);
            } else {
              fileEntries.push(e);
            }
          });
          for (const entry of dirEntries) {
            const dirPath = getPath(entry);
            const dirAttr = keepOriginalPermission ? entry.header.fileAttr : void 0;
            try {
              filetools.makeDir(dirPath);
              if (dirAttr) filetools.fs.chmodSync(dirPath, dirAttr);
              filetools.fs.utimesSync(dirPath, entry.header.time, entry.header.time);
            } catch (er) {
              callback(getError("Unable to create folder", dirPath));
            }
          }
          fileEntries.reverse().reduce(function(next, entry) {
            return function(err) {
              if (err) {
                next(err);
              } else {
                const entryName = pth.normalize(canonical(entry.entryName));
                const filePath = sanitize(targetPath, entryName);
                entry.getDataAsync(function(content, err_1) {
                  if (err_1) {
                    next(err_1);
                  } else if (!content) {
                    next(Utils.Errors.CANT_EXTRACT_FILE());
                  } else {
                    const fileAttr = keepOriginalPermission ? entry.header.fileAttr : void 0;
                    filetools.writeFileToAsync(filePath, content, overwrite, fileAttr, function(succ) {
                      if (!succ) {
                        next(getError("Unable to write file", filePath));
                      }
                      filetools.fs.utimes(filePath, entry.header.time, entry.header.time, function(err_2) {
                        if (err_2) {
                          next(getError("Unable to set times", filePath));
                        } else {
                          next();
                        }
                      });
                    });
                  }
                });
              }
            };
          }, callback)();
        },
        /**
         * Writes the newly created zip file to disk at the specified location or if a zip was opened and no ``targetFileName`` is provided, it will overwrite the opened zip
         *
         * @param {string} targetFileName
         * @param {function} callback
         */
        writeZip: function(targetFileName, callback) {
          if (arguments.length === 1) {
            if (typeof targetFileName === "function") {
              callback = targetFileName;
              targetFileName = "";
            }
          }
          if (!targetFileName && opts.filename) {
            targetFileName = opts.filename;
          }
          if (!targetFileName) return;
          var zipData = _zip.compressToBuffer();
          if (zipData) {
            var ok = filetools.writeFileTo(targetFileName, zipData, true);
            if (typeof callback === "function") callback(!ok ? new Error("failed") : null, "");
          }
        },
        /**
                 *
                 * @param {string} targetFileName
                 * @param {object} [props]
                 * @param {boolean} [props.overwrite=true] If the file already exists at the target path, the file will be overwriten if this is true.
                 * @param {boolean} [props.perm] The file will be set as the permission from the entry if this is true.
        
                 * @returns {Promise<void>}
                 */
        writeZipPromise: function(targetFileName, props) {
          const { overwrite, perm } = Object.assign({ overwrite: true }, props);
          return new Promise((resolve2, reject) => {
            if (!targetFileName && opts.filename) targetFileName = opts.filename;
            if (!targetFileName) reject("ADM-ZIP: ZIP File Name Missing");
            this.toBufferPromise().then((zipData) => {
              const ret = (done) => done ? resolve2(done) : reject("ADM-ZIP: Wasn't able to write zip file");
              filetools.writeFileToAsync(targetFileName, zipData, overwrite, perm, ret);
            }, reject);
          });
        },
        /**
         * @returns {Promise<Buffer>} A promise to the Buffer.
         */
        toBufferPromise: function() {
          return new Promise((resolve2, reject) => {
            _zip.toAsyncBuffer(resolve2, reject);
          });
        },
        /**
         * Returns the content of the entire zip file as a Buffer object
         *
         * @prop {function} [onSuccess]
         * @prop {function} [onFail]
         * @prop {function} [onItemStart]
         * @prop {function} [onItemEnd]
         * @returns {Buffer}
         */
        toBuffer: function(onSuccess, onFail, onItemStart, onItemEnd) {
          if (typeof onSuccess === "function") {
            _zip.toAsyncBuffer(onSuccess, onFail, onItemStart, onItemEnd);
            return null;
          }
          return _zip.compressToBuffer();
        }
      };
    };
  }
});

// src/electron-dev-controls/main.cts
var import_electron2 = require("electron");

// src/electron-main/dev/dev-controls-window.ts
var import_node_child_process3 = require("node:child_process");
var import_promises = require("node:fs/promises");
var import_node_path5 = __toESM(require("node:path"), 1);

// dune/src/internal/rpc/contract.ts
function declareRpcContract(edge, ...events) {
  return { edge, hasEvents: events.length > 0 };
}

// dune/src/internal/rpc/edge.ts
function edgeFamily() {
  return (trust, methods) => {
    const stamped = {};
    for (const [name, run] of Object.entries(methods)) {
      stamped[name] = { trust, run };
    }
    return stamped;
  };
}
var EDGE_UNTRUSTED_SENDER = "edge/untrusted-sender";
var EDGE_HANDLER_FAILED = "edge/handler-failed";
var EdgeCallFailure = class extends Error {
  code;
  detail;
  constructor(failure) {
    super(`${failure.code}: ${failure.detail}`);
    this.name = "EdgeCallFailure";
    this.code = failure.code;
    this.detail = failure.detail;
  }
};
var EdgeTrustPolicyMissingError = class extends Error {
  constructor(claim) {
    super(
      `serveEdge(${claim.edge}): "${claim.method}" names undeclared trust policy "${claim.trust}".`
    );
    this.name = "EdgeTrustPolicyMissingError";
  }
};
function methodChannel(edge, method) {
  return `sand-rpc:${edge}:m:${method}`;
}
function eventChannel(edge, event) {
  return `sand-rpc:${edge}:e:${event}`;
}
function serveEdge(contract, table, options) {
  const handlers = options.handlers;
  const channels = [];
  for (const method of Object.keys(table)) {
    const handler = handlers[method];
    if (handler == null) {
      throw new EdgeTrustPolicyMissingError({
        edge: contract.edge,
        method,
        trust: "<missing handler>"
      });
    }
    const policy = options.trust[handler.trust];
    if (policy == null) {
      throw new EdgeTrustPolicyMissingError({ edge: contract.edge, method, trust: handler.trust });
    }
    const channel = methodChannel(contract.edge, method);
    channels.push(channel);
    options.transport.handle(channel, async (sender, payload) => {
      if (policy.kind === "require" && !policy.test(sender)) {
        options.report?.({ method, trust: handler.trust });
        return {
          ok: false,
          failure: { code: EDGE_UNTRUSTED_SENDER, detail: policy.denial }
        };
      }
      try {
        return { ok: true, value: await handler.run(payload, sender) };
      } catch (error) {
        if (error instanceof EdgeCallFailure) {
          return { ok: false, failure: { code: error.code, detail: error.detail } };
        }
        const detail = error instanceof Error ? error.message : String(error);
        return { ok: false, failure: { code: EDGE_HANDLER_FAILED, detail } };
      }
    });
  }
  let disposed = false;
  return {
    emit: (event, payload) => {
      options.transport.broadcast(eventChannel(contract.edge, event), payload);
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const channel of channels) {
        options.transport.removeHandler(channel);
      }
    }
  };
}

// dune/src/internal/scheduling/clock.ts
var realClock = {
  now: () => Date.now(),
  monotonicNow: () => performance.now(),
  schedule(delayMs, fn) {
    assertDelay(delayMs);
    let active = true;
    const timer = globalThis.setTimeout(() => {
      if (!active) return;
      active = false;
      fn();
    }, delayMs);
    timer.unref?.();
    return {
      dispose() {
        if (!active) return;
        active = false;
        globalThis.clearTimeout(timer);
      }
    };
  }
};
function assertDelay(delayMs) {
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new RangeError("delayMs must be a finite non-negative number");
  }
}

// dune/src/internal/scheduling/policies.ts
var DeadlineExceededError = class extends Error {
  constructor(policyName) {
    super(`Deadline exceeded for ${policyName}`);
    this.policyName = policyName;
    this.name = "DeadlineExceededError";
  }
  policyName;
  code = "deadline_exceeded";
};
function createDeadlinePolicy(clock, options) {
  assertName(options.name);
  assertDuration(options.timeoutMs, "timeoutMs");
  return {
    name: options.name,
    async run(work, signal) {
      if (signal?.aborted) throw abortReason(signal);
      const controller = new AbortController();
      let rejectTimeout = () => {
      };
      const timeout = new Promise((_, reject) => {
        rejectTimeout = reject;
      });
      let rejectCancellation = () => {
      };
      const cancellation = new Promise((_, reject) => {
        rejectCancellation = reject;
      });
      let removeAbortListener = () => {
      };
      if (signal != null) {
        const abort = () => {
          const reason = abortReason(signal);
          rejectCancellation(reason);
          controller.abort(reason);
        };
        signal.addEventListener("abort", abort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", abort);
      }
      const deadline = clock.schedule(options.timeoutMs, () => {
        const error = new DeadlineExceededError(options.name);
        rejectTimeout(error);
        controller.abort(error);
      });
      try {
        return await Promise.race([work(controller.signal), timeout, cancellation]);
      } finally {
        deadline.dispose();
        removeAbortListener();
      }
    }
  };
}
function abortReason(signal) {
  return signal.reason ?? createAbortError();
}
function createAbortError() {
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}
function assertName(name, field = "name") {
  if (name.trim().length === 0) {
    throw new TypeError(`${field} must not be empty`);
  }
}
function assertDuration(value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }
}

// dune/src/scheduling.ts
function createDeadlinePolicy2(options) {
  return createDeadlinePolicy(realClock, options);
}

// src/electron-main/dev/dev-controls-window.ts
var import_electron = require("electron");

// src/host/host-paths.ts
var import_node_os = require("node:os");
var import_node_path = require("node:path");

// src/shared/node/sand-variant.ts
function isSandPackaged() {
  return process.env.SAND_PACKAGED === "1";
}
function isSandLabBuild() {
  return process.env.SAND_LAB === "1";
}
function getSandVariant() {
  return !isSandPackaged() ? "sand-dev" : isSandLabBuild() ? "sand-lab" : "sand";
}

// src/host/host-paths.ts
var SAND_DATA_ROOT_ENV = "SAND_DATA_ROOT";
var SAND_PRODUCTION_DATA_DIRNAME = ".grokbot";
var SAND_USER_DATA_DIR_ENV = "SAND_USER_DATA_DIR";
var SAND_DATA_DIRNAME = "sand-data";
var USER_DATA_DIR_FLAG = "--user-data-dir";
var SAND_BOX_HOME_DIR = "/home/box";
var SAND_BOX_DATA_ROOT = `${SAND_BOX_HOME_DIR}/${SAND_DATA_DIRNAME}`;
function readUserDataDirArg(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === USER_DATA_DIR_FLAG) {
      const next = argv[i + 1];
      return next != null && !next.startsWith("--") ? next : null;
    }
    const prefix = `${USER_DATA_DIR_FLAG}=`;
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return null;
}
function resolveSandUserDataDir(argv = [], env = process.env, cwd = process.cwd()) {
  const raw = readUserDataDirArg(argv) ?? env[SAND_USER_DATA_DIR_ENV];
  const trimmed = raw?.trim();
  if (trimmed == null || trimmed.length === 0) return null;
  return (0, import_node_path.isAbsolute)(trimmed) ? trimmed : (0, import_node_path.resolve)(cwd, trimmed);
}
function getSandProductionRootDir(homeDir = (0, import_node_os.homedir)()) {
  return (0, import_node_path.join)(homeDir, SAND_PRODUCTION_DATA_DIRNAME);
}
function resolveSandDataRootOverride(env = process.env) {
  const override = env[SAND_DATA_ROOT_ENV]?.trim();
  return override != null && override.length > 0 && (0, import_node_path.isAbsolute)(override) ? override : null;
}
function getSandRootDir(homeDir = (0, import_node_os.homedir)()) {
  const override = resolveSandDataRootOverride();
  if (override != null) return override;
  const userDataDir = resolveSandUserDataDir([], process.env);
  if (userDataDir != null) {
    return (0, import_node_path.join)(userDataDir, SAND_DATA_DIRNAME);
  }
  const variant = getSandVariant();
  return variant === "sand" ? getSandProductionRootDir(homeDir) : (0, import_node_path.join)(homeDir, ".cursor", variant);
}

// src/shared/desktop.ts
var SAND_THEME_PREFERENCES = ["system", "light", "dark"];
function isSandThemePreference(value) {
  return typeof value === "string" && SAND_THEME_PREFERENCES.includes(value);
}
function isSandThemeState(value) {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return false;
  if (!("preference" in value) || !isSandThemePreference(value.preference)) return false;
  return "resolved" in value && (value.resolved === "light" || value.resolved === "dark");
}

// src/shared/rpc/dev-controls.ts
var devControlsRpcContract = declareRpcContract("dev-controls");
var DEV_CONTROLS_METHOD_TABLE = {
  restartElectron: { args: "none" },
  reloadWindow: { args: "none" },
  restartOnboarding: { args: "none" },
  skipOnboarding: { args: "none" },
  themeStatus: { args: "none" },
  setThemePreference: { args: "object" },
  boxStatus: { args: "none" },
  boxHealth: { args: "none" },
  upgradeHost: { args: "none" },
  pokeHostUpgrade: { args: "none" },
  rebuildBox: { args: "none" },
  tailLogs: { args: "none" },
  startBox: { args: "none" },
  teardownBox: { args: "none" },
  nukeBox: { args: "none" },
  openDesktop: { args: "none" },
  boxStoreStatus: { args: "none" },
  boxStoreSnapshotNow: { args: "none" },
  boxStoreLogs: { args: "none" },
  boxStoreRecreateFresh: { args: "none" },
  boxStoreClear: { args: "none" },
  attachProdBoxStatus: { args: "none" },
  setAttachProdBoxEnabled: { args: "object" },
  setWidgetGallery: { args: "object" },
  gatewayOfflineStatus: { args: "none" },
  setGatewayOffline: { args: "object" },
  onePasswordCliStatus: { args: "none" },
  prepareOnePasswordCli: { args: "none" },
  cancelOnePasswordCliPrepare: { args: "none" },
  onePasswordAccounts: { args: "none" },
  onePasswordVaults: { args: "none" },
  onePasswordFindVault: { args: "none" },
  onePasswordSyntheticProvisioning: { args: "none" }
};

// src/electron-main/desktop-edge-failures.ts
var PRE_INSTALL_BUFFER_CAP = 32;
var reporter;
var pendingPreInstall = [];
function errorClassOf(error) {
  if (!(error instanceof Error)) return typeof error;
  return error.name.length > 0 ? error.name : "Error";
}
function reportDesktopEdgeFailure(area, leg, error) {
  reportDesktopEdgeFailureClass(area, leg, errorClassOf(error));
}
function reportDesktopEdgeFailureClass(area, leg, errorClass) {
  const failure = { area, leg, errorClass };
  if (reporter != null) {
    reporter(failure);
    return;
  }
  if (pendingPreInstall.length >= PRE_INSTALL_BUFFER_CAP) return;
  pendingPreInstall.push(failure);
}

// src/electron-main/onepassword/onepassword-cli-dev-controls.ts
var import_node_path3 = __toESM(require("node:path"), 1);

// src/shared/invariant.ts
var SandInvariantViolation = class extends Error {
  constructor(message) {
    super(message);
    this.name = "SandInvariantViolation";
  }
};
var installedReporter = null;
var STRIPPED_MESSAGE = "Invariant violation (message stripped in packaged builds; the stack identifies the site)";
function messagesStripped() {
  return true;
}
var FRAME_LINE = /^at /;
var OWN_FRAME = /^at (?:new SandInvariantViolation\b|invariant\b|installInvariantReporter\b)/;
function topApplicationFrame(violation) {
  const stack = violation.stack;
  if (stack == null || !stack.startsWith(headerOf(violation))) return null;
  for (const raw of stack.slice(headerOf(violation).length).split("\n")) {
    const frame = raw.trim();
    if (!FRAME_LINE.test(frame) || OWN_FRAME.test(frame)) continue;
    return frame;
  }
  return null;
}
function headerOf(violation) {
  return violation.message === "" ? violation.name : `${violation.name}: ${violation.message}`;
}
function invariant(condition, message) {
  if (condition) return;
  let violationMessage;
  if (messagesStripped()) {
    violationMessage = STRIPPED_MESSAGE;
  } else if (typeof message === "function") {
    violationMessage = message();
  } else {
    violationMessage = message;
  }
  const violation = new SandInvariantViolation(violationMessage);
  installedReporter?.({ name: violation.name, frame: topApplicationFrame(violation) });
  throw violation;
}

// src/electron-main/onepassword/onepassword-cli-runtime.ts
var import_node_child_process = require("node:child_process");
var import_node_crypto = require("node:crypto");
var import_node_fs = require("node:fs");
var import_node_path2 = require("node:path");
var import_adm_zip = __toESM(require_adm_zip(), 1);

// src/shared/node/async.ts
function delay(ms, signal) {
  return delayWith(realClock, ms, signal);
}
function delayWith(clock, ms, signal) {
  return new Promise((resolve2) => {
    if (signal?.aborted === true) {
      resolve2();
      return;
    }
    const onAbort = () => {
      scheduled.dispose();
      resolve2();
    };
    const scheduled = clock.schedule(Number.isFinite(ms) && ms > 0 ? ms : 0, () => {
      signal?.removeEventListener("abort", onAbort);
      resolve2();
    });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// src/electron-main/onepassword/onepassword-cli-runtime.ts
var MANAGED_ONEPASSWORD_CLI_VERSION = "2.35.0";
var ONEPASSWORD_CODESIGN_REQUIREMENT = 'identifier "com.1password.op" and anchor apple generic and certificate leaf[subject.OU] = "2BUA8C4S2C"';
var SAND_OP_LAUNCHER_IDENTIFIER_REQUIREMENT = 'identifier "sand-op-launcher"';
var SAND_OP_LAUNCHER_CODESIGN_REQUIREMENT = `${SAND_OP_LAUNCHER_IDENTIFIER_REQUIREMENT} and anchor apple generic and certificate leaf[subject.OU] = "DCNK4UB866"`;
var ONEPASSWORD_SYSTEM_CLI_PATHS = [
  "/opt/homebrew/bin/op",
  "/usr/local/bin/op",
  "/usr/bin/op"
];
var MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
var MAX_EXECUTABLE_BYTES = 64 * 1024 * 1024;
var MAX_PROCESS_OUTPUT_BYTES = 16 * 1024;
var DOWNLOAD_TIMEOUT_MS = 6e4;
var VERIFY_TIMEOUT_MS = 15e3;
var VERSION_TIMEOUT_MS = 15e3;
var ALLOWED_ARCHIVE_CONTENT_TYPES = /* @__PURE__ */ new Set([
  "application/zip",
  "application/octet-stream",
  "binary/octet-stream"
]);
function isReadyCandidate(candidate) {
  return candidate.state === "ready";
}
function defaultProcess(file, args, options) {
  return new Promise((resolve2, reject) => {
    (0, import_node_child_process.execFile)(
      file,
      [...args],
      {
        signal: options.signal,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBufferBytes,
        windowsHide: true,
        env: options.env == null ? process.env : { ...options.env }
      },
      (error, stdout, stderr) => {
        if (error != null) {
          reject(error);
          return;
        }
        resolve2({ stdout: stdout.toString(), stderr: stderr.toString() });
      }
    );
  });
}
var SandOnePasswordCliError = class extends Error {
};
function strictOpEntry(archive) {
  if (archive.byteLength === 0 || archive.byteLength > MAX_ARCHIVE_BYTES) {
    throw new SandOnePasswordCliError("The 1Password CLI archive size is invalid.");
  }
  let zip;
  try {
    zip = new import_adm_zip.default(Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength));
  } catch {
    throw new SandOnePasswordCliError("The 1Password CLI archive is invalid.");
  }
  const entries = zip.getEntries();
  const names = new Set(entries.map((entry2) => entry2.entryName));
  if (entries.length !== 2 || !names.has("op") || !names.has("op.sig")) {
    throw new SandOnePasswordCliError("The 1Password CLI archive has unexpected entries.");
  }
  const entry = entries.find((candidate) => candidate.entryName === "op");
  const signature = entries.find((candidate) => candidate.entryName === "op.sig");
  if (entry == null || entry.isDirectory || entry.header.size <= 0 || entry.header.size > MAX_EXECUTABLE_BYTES) {
    throw new SandOnePasswordCliError("The 1Password CLI archive does not contain a valid op.");
  }
  if (signature == null || signature.isDirectory || signature.header.size <= 0 || signature.header.size > 4 * 1024) {
    throw new SandOnePasswordCliError("The 1Password CLI archive signature entry is invalid.");
  }
  const unixMode = entry.attr >>> 16 & 65535;
  const signatureMode = signature.attr >>> 16 & 65535;
  if ((unixMode & 61440) === 40960 || (signatureMode & 61440) === 40960) {
    throw new SandOnePasswordCliError("The 1Password CLI archive entry cannot be a symlink.");
  }
  const executable = entry.getData();
  if (executable.byteLength !== entry.header.size || executable.byteLength > MAX_EXECUTABLE_BYTES) {
    throw new SandOnePasswordCliError("The 1Password CLI executable size is invalid.");
  }
  return executable;
}
function versionIsBounded(raw) {
  const version = raw.trim();
  return /^2\.\d{1,3}\.\d{1,3}(?:[-+][0-9A-Za-z.-]{1,64})?$/.test(version) ? version : null;
}
var SandOnePasswordCliRuntime = class {
  constructor(options) {
    this.options = options;
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.systemPaths = options.systemPaths ?? ONEPASSWORD_SYSTEM_CLI_PATHS;
    this.download = options.download ?? downloadFromOnePassword;
    this.runProcess = options.runProcess ?? defaultProcess;
  }
  options;
  platform;
  arch;
  systemPaths;
  download;
  runProcess;
  async resolveVerifiedLauncherPath(signal) {
    if (this.platform !== "darwin") {
      throw new SandOnePasswordCliError(
        "The secure 1Password launcher is supported on macOS only."
      );
    }
    await import_node_fs.promises.access(this.options.launcherPath, import_node_fs.constants.X_OK);
    const resolvedPath = await import_node_fs.promises.realpath(this.options.launcherPath);
    const requirement = this.options.launcherVerification === "development" ? SAND_OP_LAUNCHER_IDENTIFIER_REQUIREMENT : SAND_OP_LAUNCHER_CODESIGN_REQUIREMENT;
    await this.runProcess(
      "/usr/bin/codesign",
      ["--verify", "--strict", "--verbose=4", `-R=${requirement}`, resolvedPath],
      {
        signal,
        timeoutMs: VERIFY_TIMEOUT_MS,
        maxBufferBytes: MAX_PROCESS_OUTPUT_BYTES
      }
    );
    return resolvedPath;
  }
  get managedPath() {
    return (0, import_node_path2.join)(
      this.options.installRoot,
      `v${MANAGED_ONEPASSWORD_CLI_VERSION}`,
      this.artifactArch(),
      "op"
    );
  }
  async inspect(signal) {
    if (this.platform !== "darwin") {
      return {
        platformSupported: false,
        selected: null,
        candidates: [],
        detail: "Managed 1Password CLI is supported on macOS only"
      };
    }
    const launcherPath = await this.resolveVerifiedLauncherPath(signal);
    const candidates = await Promise.all(
      [
        ...this.systemPaths.map((path3) => [path3, "system"]),
        [this.managedPath, "managed"]
      ].map(
        async ([path3, source]) => await this.inspectCandidate(path3, source, launcherPath, signal)
      )
    );
    const readyCandidates = candidates.filter(isReadyCandidate);
    const selected = readyCandidates.find((candidate) => candidate.source === "system") ?? readyCandidates.find((candidate) => candidate.source === "managed") ?? null;
    return {
      platformSupported: true,
      selected,
      candidates,
      detail: selected != null ? `${selected.source === "system" ? "System" : "Managed"} CLI ready` : "No verified 1Password CLI is ready"
    };
  }
  async prepareManaged(signal) {
    const installation = await this.ensureManagedInstalled(signal);
    return await this.inspect(installation.committed ? new AbortController().signal : signal);
  }
  async resolveVerifiedPath(signal, options) {
    const inspected = await this.inspect(signal);
    if (inspected.selected != null) return inspected.selected.path;
    if (!options.prepareManaged) {
      throw new SandOnePasswordCliError("No verified 1Password CLI is ready.");
    }
    return (await this.ensureManagedInstalled(signal)).path;
  }
  async verify(path3, signal) {
    if (this.platform !== "darwin") {
      throw new SandOnePasswordCliError("Managed 1Password CLI is supported on macOS only.");
    }
    const resolvedPath = await import_node_fs.promises.realpath(path3);
    await this.runProcess(
      "/usr/bin/codesign",
      [
        "--verify",
        "--strict",
        "--verbose=4",
        `-R=${ONEPASSWORD_CODESIGN_REQUIREMENT}`,
        resolvedPath
      ],
      {
        signal,
        timeoutMs: VERIFY_TIMEOUT_MS,
        maxBufferBytes: MAX_PROCESS_OUTPUT_BYTES
      }
    );
  }
  async inspectCandidate(path3, source, launcherPath, signal) {
    try {
      await import_node_fs.promises.access(path3, import_node_fs.constants.X_OK);
    } catch {
      return { source, path: path3, state: "missing" };
    }
    try {
      const version = await this.readVersion({ path: path3, launcherPath, signal });
      if (version == null || source === "managed" && version !== MANAGED_ONEPASSWORD_CLI_VERSION) {
        return { source, path: path3, state: "invalid" };
      }
      return { source, path: path3, state: "ready", version, signature: "verified" };
    } catch (error) {
      if (signal.aborted) throw error;
      return { source, path: path3, state: "invalid" };
    }
  }
  async readVersion(options) {
    const resolvedPath = await import_node_fs.promises.realpath(options.path);
    const result = await this.runProcess(options.launcherPath, [resolvedPath, "--version"], {
      signal: options.signal,
      timeoutMs: VERSION_TIMEOUT_MS,
      maxBufferBytes: MAX_PROCESS_OUTPUT_BYTES,
      env: scrubbedOnePasswordEnvironment()
    });
    return versionIsBounded(result.stdout);
  }
  async ensureManagedInstalled(signal) {
    const destination = this.managedPath;
    const launcherPath = await this.resolveVerifiedLauncherPath(signal);
    try {
      await import_node_fs.promises.access(destination, import_node_fs.constants.X_OK);
      await this.verify(destination, signal);
      const version = await this.readVersion({
        path: destination,
        launcherPath,
        signal
      });
      if (version === MANAGED_ONEPASSWORD_CLI_VERSION) {
        return { path: destination, committed: false };
      }
    } catch (error) {
      if (signal.aborted) throw error;
    }
    const destinationDirectory = (0, import_node_path2.dirname)(destination);
    await import_node_fs.promises.mkdir(destinationDirectory, { recursive: true, mode: 448 });
    await import_node_fs.promises.chmod(this.options.installRoot, 448);
    await import_node_fs.promises.chmod(destinationDirectory, 448);
    const downloadController = new AbortController();
    const deadlineController = new AbortController();
    const downloadPromise = this.download(
      this.artifactUrl(this.artifactArch()),
      AbortSignal.any([signal, downloadController.signal])
    );
    const downloadOutcomePromise = downloadPromise.then(
      (archive2) => ({ kind: "download", archive: archive2 }),
      (error) => ({ kind: "error", error })
    );
    const deadlinePromise = delay(DOWNLOAD_TIMEOUT_MS, deadlineController.signal).then(() => ({
      kind: "timeout"
    }));
    const outcome = await Promise.race([downloadOutcomePromise, deadlinePromise]).finally(() => {
      deadlineController.abort();
    });
    if (outcome.kind === "timeout") {
      const timeoutError = new DOMException("1Password CLI download timed out", "TimeoutError");
      downloadController.abort(timeoutError);
      throw timeoutError;
    }
    if (outcome.kind === "error") throw outcome.error;
    const archive = outcome.archive;
    const executable = strictOpEntry(archive);
    const temporaryPath = (0, import_node_path2.join)(destinationDirectory, `.op-${process.pid}-${(0, import_node_crypto.randomUUID)()}`);
    try {
      const file = await import_node_fs.promises.open(temporaryPath, "wx", 448);
      try {
        await file.writeFile(executable);
        await file.sync();
      } finally {
        await file.close();
      }
      await import_node_fs.promises.chmod(temporaryPath, 448);
      await this.verify(temporaryPath, signal);
      const version = await this.readVersion({
        path: temporaryPath,
        launcherPath,
        signal
      });
      if (version !== MANAGED_ONEPASSWORD_CLI_VERSION) {
        throw new SandOnePasswordCliError(
          `The managed 1Password CLI did not report version ${MANAGED_ONEPASSWORD_CLI_VERSION}.`
        );
      }
      signal.throwIfAborted();
      await import_node_fs.promises.rename(temporaryPath, destination);
      const committedSignal = new AbortController().signal;
      await import_node_fs.promises.chmod(destination, 448);
      await this.verify(destination, committedSignal);
      return { path: destination, committed: true };
    } finally {
      await import_node_fs.promises.rm(temporaryPath, { force: true });
    }
  }
  artifactArch() {
    if (this.platform !== "darwin") {
      throw new SandOnePasswordCliError("Managed 1Password CLI is supported on macOS only.");
    }
    if (this.arch === "arm64") return "arm64";
    if (this.arch === "x64") return "amd64";
    throw new SandOnePasswordCliError("Unsupported macOS architecture.");
  }
  artifactUrl(arch) {
    return `https://cache.agilebits.com/dist/1P/op2/pkg/v${MANAGED_ONEPASSWORD_CLI_VERSION}/op_darwin_${arch}_v${MANAGED_ONEPASSWORD_CLI_VERSION}.zip`;
  }
};
function scrubbedOnePasswordEnvironment(env = process.env) {
  const scrubbed = {};
  for (const [key, value] of Object.entries(env)) {
    if (value == null) continue;
    if (key.startsWith("OP_")) continue;
    scrubbed[key] = value;
  }
  scrubbed.OP_CACHE = "false";
  scrubbed.OP_BIOMETRIC_UNLOCK_ENABLED = "true";
  scrubbed.OP_LOAD_DESKTOP_APP_SETTINGS = "false";
  return scrubbed;
}
async function downloadFromOnePassword(rawUrl, signal) {
  const url = new URL(rawUrl);
  const expectedPaths = /* @__PURE__ */ new Set([
    `/dist/1P/op2/pkg/v${MANAGED_ONEPASSWORD_CLI_VERSION}/op_darwin_arm64_v${MANAGED_ONEPASSWORD_CLI_VERSION}.zip`,
    `/dist/1P/op2/pkg/v${MANAGED_ONEPASSWORD_CLI_VERSION}/op_darwin_amd64_v${MANAGED_ONEPASSWORD_CLI_VERSION}.zip`
  ]);
  if (url.protocol !== "https:" || url.hostname !== "cache.agilebits.com" || url.port !== "" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || !expectedPaths.has(url.pathname)) {
    throw new SandOnePasswordCliError("The 1Password CLI download URL is not vendor-owned.");
  }
  const response = await fetch(url, { redirect: "error", signal });
  if (!response.ok) {
    if (response.body != null) {
      await response.body.cancel().catch((error) => reportDesktopEdgeFailure("onepassword", "body-cancel", error));
    }
    throw new SandOnePasswordCliError(
      `The 1Password CLI download failed with HTTP ${response.status}.`
    );
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType == null || !ALLOWED_ARCHIVE_CONTENT_TYPES.has(contentType)) {
    if (response.body != null) {
      await response.body.cancel().catch((error) => reportDesktopEdgeFailure("onepassword", "body-cancel", error));
    }
    throw new SandOnePasswordCliError("The 1Password CLI download type could not be verified.");
  }
  const contentLength = response.headers.get("content-length");
  const length = contentLength == null ? Number.NaN : Number(contentLength);
  if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_ARCHIVE_BYTES) {
    if (response.body != null) {
      await response.body.cancel().catch((error) => reportDesktopEdgeFailure("onepassword", "body-cancel", error));
    }
    throw new SandOnePasswordCliError("The 1Password CLI download size could not be verified.");
  }
  if (response.body == null) {
    throw new SandOnePasswordCliError("The 1Password CLI download body was missing.");
  }
  const reader = response.body.getReader();
  const archive = new Uint8Array(length);
  let received = 0;
  for (; ; ) {
    const next = await reader.read();
    if (next.done) break;
    const nextReceived = received + next.value.byteLength;
    if (nextReceived > MAX_ARCHIVE_BYTES || nextReceived > length) {
      await reader.cancel();
      throw new SandOnePasswordCliError("The 1Password CLI download was unexpectedly large.");
    }
    archive.set(next.value, received);
    received = nextReceived;
  }
  if (received !== length) {
    throw new SandOnePasswordCliError("The 1Password CLI download size did not match.");
  }
  return archive;
}

// src/electron-main/onepassword/onepassword-op-executor.ts
var import_node_child_process2 = require("node:child_process");

// src/electron-main/onepassword/onepassword-provisioning-contract.ts
var OnePasswordProvisioningError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "OnePasswordProvisioningError";
  }
  code;
};
var unavailableOnePasswordProvisioningSink = {
  availability: "unavailable",
  async accept() {
    throw new OnePasswordProvisioningError(
      "sink-unavailable",
      "1Password provisioning is unavailable until a credential consumer is configured."
    );
  }
};

// src/electron-main/onepassword/onepassword-op-executor.ts
var OnePasswordProcessError = class extends Error {
  constructor(processCode, killed, failureKind2) {
    super("The 1Password CLI command failed.");
    this.processCode = processCode;
    this.killed = killed;
    this.failureKind = failureKind2;
    this.name = "OnePasswordProcessError";
  }
  processCode;
  killed;
  failureKind;
};
function failureKind(raw) {
  const text = raw.toLowerCase();
  if (text.includes("authorization prompt dismissed") || text.includes("request was denied") || text.includes("authorization denied") || text.includes("rejected")) {
    return "denied";
  }
  if (text.includes("connecting to desktop app") || text.includes("desktop app not running") || text.includes("cli is not enabled") || text.includes("couldn't connect to the 1password app") || text.includes("no accounts configured")) {
    return "integration-off";
  }
  if (text.includes("permission") || text.includes("not allowed") || text.includes("(403)") || text.includes("forbidden")) {
    return "permission";
  }
  if (text.includes("already exists") || text.includes("(409)") || text.includes("conflict")) {
    return "conflict";
  }
  if (text.includes("etimedout") || text.includes("timed out")) {
    return "timeout";
  }
  return "unknown";
}
function createOnePasswordOpExecutor() {
  return async (file, args, options) => await new Promise((resolve2, reject) => {
    (0, import_node_child_process2.execFile)(
      file,
      [...args],
      {
        signal: options.signal,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBufferBytes,
        windowsHide: true,
        env: { ...options.env }
      },
      (error, stdout, stderr) => {
        if (error != null) {
          reject(
            new OnePasswordProcessError(
              Reflect.get(error, "code"),
              Reflect.get(error, "killed") === true,
              failureKind(`${error.message}
${stderr.toString()}`)
            )
          );
          return;
        }
        resolve2({ stdout: stdout.toString(), stderr: stderr.toString() });
      }
    );
  });
}
function classifyOnePasswordProcessFailure(error) {
  if (error instanceof OnePasswordProvisioningError) return error;
  if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return new OnePasswordProvisioningError(
      error.name === "AbortError" ? "cancelled" : "timeout",
      error.name === "AbortError" ? "The 1Password operation was canceled." : "The 1Password operation timed out."
    );
  }
  const processError = error instanceof OnePasswordProcessError ? error : void 0;
  const processCode = processError?.processCode ?? (typeof error === "object" && error != null ? Reflect.get(error, "code") : void 0);
  const killed = processError?.killed ?? (typeof error === "object" && error != null && Reflect.get(error, "killed") === true);
  if (processCode === "ENOENT") {
    return new OnePasswordProvisioningError(
      "missing-cli",
      "The secure 1Password CLI runtime is unavailable."
    );
  }
  if (processCode === "ABORT_ERR") {
    return new OnePasswordProvisioningError("cancelled", "The 1Password operation was canceled.");
  }
  const raw = error instanceof Error ? error.message : "";
  const kind = processError?.failureKind ?? failureKind(raw);
  if (killed || kind === "timeout") {
    return new OnePasswordProvisioningError(
      "timeout",
      "The 1Password desktop app did not respond in time."
    );
  }
  if (kind === "denied") {
    return new OnePasswordProvisioningError(
      "denied",
      "The request was not approved in the 1Password desktop app."
    );
  }
  if (kind === "integration-off") {
    return new OnePasswordProvisioningError(
      "integration-off",
      "1Password desktop CLI integration is unavailable."
    );
  }
  if (kind === "permission") {
    return new OnePasswordProvisioningError(
      "permission",
      "The selected 1Password account does not allow this operation."
    );
  }
  if (kind === "conflict") {
    return new OnePasswordProvisioningError(
      "conflict",
      "The requested 1Password object already exists."
    );
  }
  return new OnePasswordProvisioningError("op-error", "The secure 1Password CLI operation failed.");
}
function classifyOnePasswordRuntimeFailure(error) {
  if (error instanceof OnePasswordProvisioningError) return error;
  if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return new OnePasswordProvisioningError(
      error.name === "AbortError" ? "cancelled" : "timeout",
      error.name === "AbortError" ? "The 1Password operation was canceled." : "The secure 1Password runtime verification timed out."
    );
  }
  const processCode = typeof error === "object" && error != null ? Reflect.get(error, "code") : void 0;
  if (processCode === "ABORT_ERR") {
    return new OnePasswordProvisioningError("cancelled", "The 1Password operation was canceled.");
  }
  if (processCode === "ENOENT") {
    return new OnePasswordProvisioningError(
      "missing-cli",
      "The secure 1Password CLI runtime is unavailable."
    );
  }
  return new OnePasswordProvisioningError(
    "op-error",
    "The secure 1Password runtime failed verification."
  );
}

// src/electron-main/onepassword/onepassword-provisioning-bridge.ts
var MINIMUM_SUPPORTED_VERSION = [2, 35, 0];
var MAX_JSON_OUTPUT_BYTES = 1024 * 1024;
var MAX_TOKEN_OUTPUT_BYTES = 16 * 1024;
var READ_TIMEOUT_MS = 3e4;
var AUTHORIZED_TIMEOUT_MS = 18e4;
var SINK_TIMEOUT_MS = 3e4;
var MAX_ACCOUNTS = 50;
var MAX_VAULTS = 1e3;
var MAX_PROVIDER_ID_LENGTH = 256;
var MAX_NAME_LENGTH = 256;
var MAX_EMAIL_LENGTH = 320;
var MAX_URL_LENGTH = 2048;
var MAX_CONSUMER_REFERENCE_LENGTH = 256;
var MAX_EXPIRATION_SECONDS = 365 * 24 * 60 * 60;
var MIN_EXPIRATION_SECONDS = 60;
function parseVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
  const parsed = version.split(".").map((part) => Number.parseInt(part, 10));
  return parsed.every((part) => Number.isSafeInteger(part)) ? parsed : null;
}
function versionAtLeast(version, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    const have = version[index] ?? 0;
    const want = minimum[index] ?? 0;
    if (have > want) return true;
    if (have < want) return false;
  }
  return true;
}
function isSupportedCandidate(candidate) {
  const version = parseVersion(candidate.version);
  return version != null && versionAtLeast(version, MINIMUM_SUPPORTED_VERSION);
}
function selectSupportedCandidate(inspection) {
  const readyCandidates = inspection.candidates.filter(
    (candidate) => candidate.state === "ready"
  );
  if (inspection.selected != null && !readyCandidates.some((candidate) => candidate.path === inspection.selected?.path)) {
    readyCandidates.unshift(inspection.selected);
  }
  return readyCandidates.find(
    (candidate) => candidate.source === "system" && isSupportedCandidate(candidate)
  ) ?? readyCandidates.find(
    (candidate) => candidate.source === "managed" && isSupportedCandidate(candidate)
  ) ?? null;
}
function isRecord(value) {
  return typeof value === "object" && value != null && !Array.isArray(value);
}
function providerIdentifier(value, field) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+$/.test(value) || value.length > MAX_PROVIDER_ID_LENGTH) {
    throw new OnePasswordProvisioningError("invalid-input", `The ${field} is invalid.`);
  }
  return value;
}
function boundedName(value, field) {
  const name = typeof value === "string" ? value.trim() : "";
  if (name.length === 0 || name.length > MAX_NAME_LENGTH || name.startsWith("-") || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new OnePasswordProvisioningError("invalid-input", `The ${field} is invalid.`);
  }
  return name;
}
function boundedMetadata(value, maximum) {
  if (typeof value !== "string") return null;
  const bounded = value.trim();
  return bounded.length > 0 && bounded.length <= maximum ? bounded : null;
}
function safeAccountUrl(value) {
  const raw = boundedMetadata(value, MAX_URL_LENGTH);
  if (raw == null) return null;
  try {
    const hasScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw);
    const url = new URL(hasScheme ? raw : `https://${raw}`);
    return url.protocol === "https:" && url.hostname !== "" && url.username === "" && url.password === "" ? url.toString() : null;
  } catch {
    return null;
  }
}
function parseAccounts(value) {
  if (!Array.isArray(value) || value.length > MAX_ACCOUNTS) {
    throw new OnePasswordProvisioningError(
      "invalid-output",
      "1Password returned an invalid account list."
    );
  }
  const accounts = [];
  const seen = /* @__PURE__ */ new Set();
  for (const entry of value) {
    if (!isRecord(entry)) {
      throw new OnePasswordProvisioningError(
        "invalid-output",
        "1Password returned an invalid account list."
      );
    }
    const accountUuid = boundedMetadata(entry.account_uuid, MAX_PROVIDER_ID_LENGTH);
    const email = boundedMetadata(entry.email, MAX_EMAIL_LENGTH);
    const url = safeAccountUrl(entry.url);
    if (accountUuid == null || !/^[A-Za-z0-9_.-]+$/.test(accountUuid) || email == null || url == null || seen.has(accountUuid)) {
      throw new OnePasswordProvisioningError(
        "invalid-output",
        "1Password returned an invalid account list."
      );
    }
    seen.add(accountUuid);
    accounts.push({ accountUuid, email, url });
  }
  return accounts;
}
function parseVaults(value) {
  if (!Array.isArray(value) || value.length > MAX_VAULTS) {
    throw new OnePasswordProvisioningError(
      "invalid-output",
      "1Password returned an invalid vault list."
    );
  }
  const vaults = [];
  const seen = /* @__PURE__ */ new Set();
  for (const entry of value) {
    if (!isRecord(entry)) {
      throw new OnePasswordProvisioningError(
        "invalid-output",
        "1Password returned an invalid vault list."
      );
    }
    const vaultId = boundedMetadata(entry.id, MAX_PROVIDER_ID_LENGTH);
    const vaultName = boundedMetadata(entry.name, MAX_NAME_LENGTH);
    if (vaultId == null || !/^[A-Za-z0-9_.-]+$/.test(vaultId) || vaultName == null || seen.has(vaultId)) {
      throw new OnePasswordProvisioningError(
        "invalid-output",
        "1Password returned an invalid vault list."
      );
    }
    seen.add(vaultId);
    vaults.push({ vaultId, vaultName });
  }
  return vaults;
}
function parseCreatedVault(value) {
  if (!isRecord(value)) {
    throw new OnePasswordProvisioningError(
      "invalid-output",
      "1Password did not return the created vault."
    );
  }
  const vaultId = boundedMetadata(value.id, MAX_PROVIDER_ID_LENGTH);
  const vaultName = boundedMetadata(value.name, MAX_NAME_LENGTH);
  if (vaultId == null || !/^[A-Za-z0-9_.-]+$/.test(vaultId) || vaultName == null) {
    throw new OnePasswordProvisioningError(
      "invalid-output",
      "1Password did not return the created vault."
    );
  }
  return { vaultId, vaultName };
}
function expirationSeconds(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < MIN_EXPIRATION_SECONDS || value > MAX_EXPIRATION_SECONDS) {
    throw new OnePasswordProvisioningError(
      "invalid-input",
      "The provisioning policy returned an invalid expiration duration."
    );
  }
  return value;
}
function validToken(stdout) {
  const token = stdout.trim();
  if (token.length === 0 || token.length > MAX_TOKEN_OUTPUT_BYTES || !/^ops_[A-Za-z0-9_-]+$/.test(token)) {
    throw new OnePasswordProvisioningError(
      "invalid-output",
      "1Password did not return a valid service-account credential."
    );
  }
  return token;
}
var OnePasswordDesktopProvisioningBridge = class {
  runtime;
  sink;
  executor;
  prepareManagedCli;
  mutationInProgress = false;
  deliveryIndeterminate = false;
  constructor(options) {
    this.runtime = options.runtime;
    this.sink = options.sink ?? unavailableOnePasswordProvisioningSink;
    this.executor = options.executor ?? createOnePasswordOpExecutor();
    this.prepareManagedCli = options.prepareManagedCli ?? true;
  }
  async inspectReadiness(signal) {
    const inspection = await this.runtime.inspect(signal).catch((error) => {
      throw classifyOnePasswordRuntimeFailure(error);
    });
    if (!inspection.platformSupported) return { state: "unsupported-platform" };
    const selected = selectSupportedCandidate(inspection);
    if (selected != null) {
      return {
        state: "ready",
        source: selected.source,
        path: selected.path,
        version: selected.version
      };
    }
    const unsupported = inspection.selected;
    if (unsupported == null) return { state: "missing-cli" };
    return {
      state: "unsupported-version",
      version: unsupported.version
    };
  }
  async listAccounts(signal) {
    return parseAccounts(
      await this.runJson(["account", "list", "--format=json"], READ_TIMEOUT_MS, signal)
    );
  }
  async listVaults(request, signal) {
    const accountUuid = providerIdentifier(request.accountUuid, "1Password account identifier");
    return parseVaults(
      await this.runJson(
        ["vault", "list", "--account", accountUuid, "--format=json"],
        READ_TIMEOUT_MS,
        signal
      )
    );
  }
  async findVault(request, signal) {
    const wanted = boundedName(request.vaultName, "vault name");
    const matches = (await this.listVaults(request, signal)).filter(
      (vault) => vault.vaultName === wanted
    );
    if (matches.length > 1) {
      throw new OnePasswordProvisioningError(
        "conflict",
        "More than one 1Password vault has the requested name."
      );
    }
    return matches[0] ?? null;
  }
  async createVault(request, signal) {
    this.assertSinkAvailable();
    const accountUuid = providerIdentifier(request.accountUuid, "1Password account identifier");
    const vaultName = boundedName(request.vaultName, "vault name");
    return await this.runMutation(signal, async (mutationSignal) => {
      return parseCreatedVault(
        await this.runJson(
          ["vault", "create", vaultName, "--account", accountUuid, "--format=json"],
          AUTHORIZED_TIMEOUT_MS,
          mutationSignal
        )
      );
    });
  }
  async mintAndDeliver(request, signal) {
    this.assertSinkAvailable();
    const accountUuid = providerIdentifier(request.accountUuid, "1Password account identifier");
    const vaultId = providerIdentifier(request.vaultId, "1Password vault identifier");
    const serviceAccountName = boundedName(request.serviceAccountName, "service-account name");
    const expiresInSeconds = expirationSeconds(request.expiresInSeconds);
    return await this.runMutation(signal, async (mutationSignal) => {
      const account = (await this.listAccounts(mutationSignal)).find(
        (candidate) => candidate.accountUuid === accountUuid
      );
      if (account == null) {
        throw new OnePasswordProvisioningError(
          "invalid-input",
          "The selected 1Password account is unavailable."
        );
      }
      const vault = (await this.listVaults({ accountUuid }, mutationSignal)).find(
        (candidate) => candidate.vaultId === vaultId
      );
      if (vault == null) {
        throw new OnePasswordProvisioningError(
          "permission",
          "The selected 1Password vault is unavailable to this account."
        );
      }
      const result = await this.runOp(
        [
          "service-account",
          "create",
          serviceAccountName,
          "--account",
          accountUuid,
          "--vault",
          `${vaultId}:read_items`,
          "--expires-in",
          `${expiresInSeconds}s`,
          "--raw"
        ],
        AUTHORIZED_TIMEOUT_MS,
        MAX_TOKEN_OUTPUT_BYTES,
        mutationSignal
      );
      const token = validToken(result.stdout);
      const sinkController = new AbortController();
      const deadlineController = new AbortController();
      let receipt;
      try {
        const sinkPromise = this.sink.accept(
          {
            accountUuid,
            accountUrl: account.url,
            vaultId,
            vaultName: vault.vaultName,
            serviceAccountName,
            expiresInSeconds,
            token
          },
          sinkController.signal
        );
        const deadlinePromise = delay(SINK_TIMEOUT_MS, deadlineController.signal).then(async () => {
          if (deadlineController.signal.aborted) return await sinkPromise;
          sinkController.abort(new DOMException("Provisioning sink timed out", "TimeoutError"));
          throw new DOMException("Provisioning sink timed out", "TimeoutError");
        });
        receipt = await Promise.race([sinkPromise, deadlinePromise]);
      } catch {
        this.deliveryIndeterminate = true;
        throw new OnePasswordProvisioningError(
          "delivery-indeterminate",
          "The credential delivery outcome is unknown and must be reconciled before provisioning again."
        );
      } finally {
        deadlineController.abort();
      }
      const consumerReference = isRecord(receipt) ? boundedMetadata(receipt.consumerReference, MAX_CONSUMER_REFERENCE_LENGTH) : null;
      if (consumerReference == null) {
        this.deliveryIndeterminate = true;
        throw new OnePasswordProvisioningError(
          "delivery-indeterminate",
          "The credential delivery outcome is unknown and must be reconciled before provisioning again."
        );
      }
      return { consumerReference, expiresInSeconds };
    });
  }
  assertSinkAvailable() {
    if (this.sink.availability !== "available") {
      throw new OnePasswordProvisioningError(
        "sink-unavailable",
        "1Password provisioning is unavailable until a credential consumer is configured."
      );
    }
  }
  async runMutation(callerSignal, operation) {
    if (this.deliveryIndeterminate) {
      throw new OnePasswordProvisioningError(
        "delivery-indeterminate",
        "The previous credential delivery must be reconciled before provisioning again."
      );
    }
    if (this.mutationInProgress) {
      throw new OnePasswordProvisioningError(
        "busy",
        "A 1Password provisioning operation is already running."
      );
    }
    this.mutationInProgress = true;
    try {
      if (callerSignal.aborted) {
        throw new OnePasswordProvisioningError(
          "cancelled",
          "The 1Password operation was canceled."
        );
      }
      return await operation(callerSignal);
    } finally {
      this.mutationInProgress = false;
    }
  }
  async runJson(args, timeoutMs, signal) {
    const result = await this.runOp(args, timeoutMs, MAX_JSON_OUTPUT_BYTES, signal);
    try {
      const parsed = JSON.parse(result.stdout);
      return parsed;
    } catch {
      throw new OnePasswordProvisioningError(
        "invalid-output",
        "1Password returned malformed JSON."
      );
    }
  }
  async runOp(args, timeoutMs, maxBufferBytes, signal) {
    const opPath = await this.resolveSupportedPath(signal);
    let launcherPath;
    try {
      launcherPath = await this.runtime.resolveVerifiedLauncherPath(signal);
    } catch (error) {
      throw classifyOnePasswordRuntimeFailure(error);
    }
    try {
      return await this.executor(launcherPath, [opPath, ...args], {
        signal,
        timeoutMs,
        maxBufferBytes,
        env: scrubbedOnePasswordEnvironment()
      });
    } catch (error) {
      throw classifyOnePasswordProcessFailure(error);
    }
  }
  async resolveSupportedPath(signal) {
    let readiness = await this.inspectReadiness(signal);
    if (readiness.state === "ready") return readiness.path;
    if ((readiness.state === "missing-cli" || readiness.state === "unsupported-version") && this.prepareManagedCli && !signal.aborted) {
      try {
        await this.runtime.prepareManaged(signal);
      } catch (error) {
        throw classifyOnePasswordRuntimeFailure(error);
      }
      readiness = await this.inspectReadiness(signal);
      if (readiness.state === "ready") return readiness.path;
    }
    if (readiness.state === "unsupported-platform") {
      throw new OnePasswordProvisioningError(
        "unsupported-platform",
        "1Password desktop provisioning is supported on macOS only."
      );
    }
    if (readiness.state === "unsupported-version") {
      throw new OnePasswordProvisioningError(
        "unsupported-version",
        "The detected 1Password CLI does not support expiring service accounts."
      );
    }
    throw new OnePasswordProvisioningError("missing-cli", "No verified 1Password CLI is ready.");
  }
};

// src/electron-main/onepassword/onepassword-cli-dev-controls.ts
var DEFAULT_VAULT_NAME = "Shared with Sand";
var SYNTHETIC_TOKEN = "ops_SYNTHETIC_DEV_ONLY_TOKEN_DO_NOT_USE";
function unavailable(detail) {
  return {
    platformSupported: process.platform === "darwin",
    selected: null,
    candidates: [],
    detail
  };
}
function isAbortError(error) {
  if (error instanceof DOMException) return error.name === "AbortError";
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || "code" in error && error.code === "ABORT_ERR";
}
function failedCheck(action, error) {
  const code = error instanceof OnePasswordProvisioningError ? ` (${error.code})` : "";
  return {
    isOk: false,
    action,
    summary: `1Password ${action} check failed safely${code}`,
    accountCount: 0,
    vaultCount: 0,
    foundDefaultVault: false
  };
}
async function runSyntheticOnePasswordProvisioningExercise() {
  let vaultCreated = false;
  let sinkAccepted = false;
  let environmentWasScrubbed = true;
  const runtime = {
    async inspect() {
      return {
        platformSupported: true,
        selected: {
          source: "managed",
          path: "/synthetic/op",
          version: "2.35.0",
          state: "ready",
          signature: "verified"
        },
        candidates: [],
        detail: "Synthetic CLI ready"
      };
    },
    async prepareManaged() {
      return await this.inspect();
    },
    async resolveVerifiedLauncherPath() {
      return "/synthetic/sand-op-launcher";
    }
  };
  const executor = async (_file, args, options) => {
    environmentWasScrubbed &&= options.env.OP_SERVICE_ACCOUNT_TOKEN == null && !Object.keys(options.env).some(
      (key) => key.startsWith("OP_SESSION") || key.startsWith("OP_CONNECT")
    );
    const command = args.slice(1);
    if (command[0] === "account") {
      return {
        stdout: JSON.stringify([
          {
            account_uuid: "synthetic-account",
            email: "synthetic@example.invalid",
            url: "https://synthetic.1password.example"
          }
        ]),
        stderr: ""
      };
    }
    if (command[0] === "vault" && command[1] === "list") {
      return {
        stdout: vaultCreated ? JSON.stringify([{ id: "synthetic-vault", name: DEFAULT_VAULT_NAME }]) : "[]",
        stderr: ""
      };
    }
    if (command[0] === "vault" && command[1] === "create") {
      vaultCreated = true;
      return {
        stdout: JSON.stringify({
          id: "synthetic-vault",
          name: DEFAULT_VAULT_NAME
        }),
        stderr: ""
      };
    }
    if (command[0] === "service-account") {
      return { stdout: SYNTHETIC_TOKEN, stderr: "" };
    }
    invariant(false, "Unexpected synthetic 1Password command.");
  };
  const sink = {
    availability: "available",
    async accept(request) {
      sinkAccepted = request.token === SYNTHETIC_TOKEN;
      return { consumerReference: "synthetic-receipt" };
    }
  };
  try {
    const bridge = new OnePasswordDesktopProvisioningBridge({
      runtime,
      executor,
      sink,
      prepareManagedCli: false
    });
    const signal = new AbortController().signal;
    const accounts = await bridge.listAccounts(signal);
    const existing = await bridge.findVault(
      {
        accountUuid: accounts[0]?.accountUuid ?? "",
        vaultName: DEFAULT_VAULT_NAME
      },
      signal
    );
    const vault = existing ?? await bridge.createVault(
      {
        accountUuid: accounts[0]?.accountUuid ?? "",
        vaultName: DEFAULT_VAULT_NAME
      },
      signal
    );
    const receipt = await bridge.mintAndDeliver(
      {
        accountUuid: accounts[0]?.accountUuid ?? "",
        vaultId: vault.vaultId,
        serviceAccountName: "Sand synthetic service account",
        expiresInSeconds: 3600
      },
      signal
    );
    const publicResult = {
      accountCount: accounts.length,
      vaultCount: 1,
      foundDefaultVault: existing != null,
      consumerReference: receipt.consumerReference
    };
    const tokenContained = !JSON.stringify(publicResult).includes(SYNTHETIC_TOKEN);
    return {
      isOk: sinkAccepted && environmentWasScrubbed && tokenContained,
      action: "synthetic-provisioning",
      summary: sinkAccepted && environmentWasScrubbed && tokenContained ? "Synthetic provisioning completed with token containment" : "Synthetic provisioning containment check failed",
      accountCount: publicResult.accountCount,
      vaultCount: publicResult.vaultCount,
      foundDefaultVault: publicResult.foundDefaultVault
    };
  } catch (error) {
    return failedCheck("synthetic-provisioning", error);
  }
}
function createOnePasswordCliDevController(options) {
  let runtime;
  let readBridge;
  let prepareController;
  const getRuntime = () => {
    return runtime ??= new SandOnePasswordCliRuntime({
      installRoot: import_node_path3.default.join(getSandRootDir(), "onepassword-cli"),
      launcherPath: import_node_path3.default.join(options.projectDir, "dist", "native", "sand-op-launcher"),
      launcherVerification: "development"
    });
  };
  const getReadBridge = () => {
    return readBridge ??= new OnePasswordDesktopProvisioningBridge({
      runtime: getRuntime(),
      sink: unavailableOnePasswordProvisioningSink,
      prepareManagedCli: false
    });
  };
  return {
    async inspect() {
      try {
        return await getRuntime().inspect(new AbortController().signal);
      } catch {
        return unavailable("1Password CLI inspection failed safely");
      }
    },
    async prepare() {
      if (prepareController != null) {
        return unavailable("Managed 1Password CLI preparation is already running");
      }
      const controller = new AbortController();
      prepareController = controller;
      try {
        return await getRuntime().prepareManaged(controller.signal);
      } catch (error) {
        return unavailable(
          isAbortError(error) ? "Managed 1Password CLI preparation canceled" : "Managed 1Password CLI preparation failed safely"
        );
      } finally {
        if (prepareController === controller) prepareController = void 0;
      }
    },
    cancel() {
      prepareController?.abort();
    },
    async listAccounts() {
      try {
        const accounts = await getReadBridge().listAccounts(new AbortController().signal);
        return {
          isOk: true,
          action: "accounts",
          summary: `${accounts.length} 1Password account${accounts.length === 1 ? "" : "s"} available`,
          accountCount: accounts.length,
          vaultCount: 0,
          foundDefaultVault: false
        };
      } catch (error) {
        return failedCheck("accounts", error);
      }
    },
    async listVaults() {
      try {
        const signal = new AbortController().signal;
        const accounts = await getReadBridge().listAccounts(signal);
        const first = accounts[0];
        if (first == null) {
          return {
            isOk: true,
            action: "vaults",
            summary: "No 1Password account is available",
            accountCount: 0,
            vaultCount: 0,
            foundDefaultVault: false
          };
        }
        const vaults = await getReadBridge().listVaults({ accountUuid: first.accountUuid }, signal);
        return {
          isOk: true,
          action: "vaults",
          summary: `${vaults.length} vault${vaults.length === 1 ? "" : "s"} available for the first account`,
          accountCount: accounts.length,
          vaultCount: vaults.length,
          foundDefaultVault: vaults.some((vault) => vault.vaultName === DEFAULT_VAULT_NAME)
        };
      } catch (error) {
        return failedCheck("vaults", error);
      }
    },
    async findDefaultVault() {
      try {
        const signal = new AbortController().signal;
        const accounts = await getReadBridge().listAccounts(signal);
        const first = accounts[0];
        if (first == null) {
          return {
            isOk: true,
            action: "find-vault",
            summary: "No 1Password account is available",
            accountCount: 0,
            vaultCount: 0,
            foundDefaultVault: false
          };
        }
        const found = await getReadBridge().findVault(
          {
            accountUuid: first.accountUuid,
            vaultName: DEFAULT_VAULT_NAME
          },
          signal
        );
        return {
          isOk: true,
          action: "find-vault",
          summary: found == null ? "The default Sand vault was not found" : "The default Sand vault is available",
          accountCount: accounts.length,
          vaultCount: found == null ? 0 : 1,
          foundDefaultVault: found != null
        };
      } catch (error) {
        return failedCheck("find-vault", error);
      }
    },
    async runSyntheticProvisioning() {
      return await runSyntheticOnePasswordProvisioningExercise();
    }
  };
}

// src/electron-main/dev/dev-attach-prod-box.ts
var import_node_fs2 = require("node:fs");
var import_node_os2 = require("node:os");
var import_node_path4 = require("node:path");
var ATTACH_PROD_BOX_PREFS_PATH = (0, import_node_path4.join)(
  (0, import_node_os2.homedir)(),
  ".cursor",
  "sand-dev",
  "attach-prod-box.json"
);
var DEFAULT_PREFS = {
  enabled: false,
  updatedAtMs: 0
};
function readAttachProdBoxPrefs() {
  try {
    const raw = (0, import_node_fs2.readFileSync)(ATTACH_PROD_BOX_PREFS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed == null || typeof parsed !== "object" || !("enabled" in parsed) || typeof parsed.enabled !== "boolean") {
      return DEFAULT_PREFS;
    }
    const updatedAtMs = "updatedAtMs" in parsed && typeof parsed.updatedAtMs === "number" ? parsed.updatedAtMs : 0;
    return {
      enabled: parsed.enabled,
      updatedAtMs
    };
  } catch {
    return DEFAULT_PREFS;
  }
}
function writeAttachProdBoxPrefs(enabled) {
  const prefs = {
    enabled,
    updatedAtMs: Date.now()
  };
  (0, import_node_fs2.mkdirSync)((0, import_node_path4.dirname)(ATTACH_PROD_BOX_PREFS_PATH), { recursive: true });
  (0, import_node_fs2.writeFileSync)(ATTACH_PROD_BOX_PREFS_PATH, `${JSON.stringify(prefs, null, 2)}
`, "utf8");
  return prefs;
}
function resolveAttachProdBoxPreferred(env = process.env) {
  const raw = env.SAND_ATTACH_PROD_BOX?.trim();
  if (raw === "1") return true;
  if (raw === "0") return false;
  return readAttachProdBoxPrefs().enabled;
}
function isAttachProdBoxActive(env = process.env) {
  return env.SAND_ATTACH_PROD_BOX === "1";
}
function getAttachProdBoxStatus(env = process.env) {
  const prefs = readAttachProdBoxPrefs();
  return {
    preferred: resolveAttachProdBoxPreferred(env),
    active: isAttachProdBoxActive(env),
    prefsPath: ATTACH_PROD_BOX_PREFS_PATH,
    updatedAtMs: prefs.updatedAtMs
  };
}

// src/electron-main/dev/dev-controls-edge.ts
function createDevControlsTrust() {
  return {
    // The panel app opens exactly one window; authorize by webContents identity.
    devControlsPanel: {
      kind: "require",
      test: (sender) => sender.isDevControlsPanel,
      denial: "The dev-controls edge is only accessible from the Dev Controls panel window."
    }
  };
}
var family = edgeFamily();
function createDevControlsHandlers(deps) {
  return {
    ...family("devControlsPanel", {
      restartElectron: () => deps.postControl("/restart"),
      reloadWindow: () => deps.postControl("/reload"),
      restartOnboarding: () => deps.postControl("/restart-onboarding"),
      skipOnboarding: () => deps.postControl("/skip-onboarding"),
      themeStatus: () => deps.fetchTheme(""),
      setThemePreference: ({ preference }) => deps.fetchTheme(`?preference=${encodeURIComponent(preference)}`),
      setWidgetGallery: ({ isOn }) => deps.postControl(`/widget-gallery?on=${isOn === true ? "1" : "0"}`),
      gatewayOfflineStatus: () => deps.fetchGatewayOffline(""),
      setGatewayOffline: ({ induced }) => deps.fetchGatewayOffline(`?induced=${induced === true ? "1" : "0"}`),
      onePasswordCliStatus: () => deps.onePasswordCli.inspect(),
      prepareOnePasswordCli: () => deps.onePasswordCli.prepare(),
      cancelOnePasswordCliPrepare: () => {
        deps.onePasswordCli.cancel();
      },
      onePasswordAccounts: () => deps.onePasswordCli.listAccounts(),
      onePasswordVaults: () => deps.onePasswordCli.listVaults(),
      onePasswordFindVault: () => deps.onePasswordCli.findDefaultVault(),
      onePasswordSyntheticProvisioning: () => deps.onePasswordCli.runSyntheticProvisioning(),
      attachProdBoxStatus: () => deps.getAttachProdBoxStatus(),
      setAttachProdBoxEnabled: async ({ enabled, isRestartMainApp }) => {
        deps.writeAttachProdBoxPrefs(enabled === true);
        const status = deps.getAttachProdBoxStatus();
        if (isRestartMainApp !== false) {
          await deps.postControl("/restart");
        }
        return status;
      },
      boxStatus: () => deps.collectBoxStatus(),
      boxHealth: () => deps.collectBoxHealth(),
      upgradeHost: () => deps.runDevBoxScript("sync"),
      pokeHostUpgrade: () => deps.pokeHostUpgrade(),
      rebuildBox: async () => {
        await deps.postControl("/box-rebuild-start");
        return await deps.runDevBoxScript("rebuild");
      },
      tailLogs: () => deps.tailBoxLogs(),
      startBox: () => deps.runDevBoxScript("up"),
      teardownBox: () => deps.runDevBoxScript("down"),
      nukeBox: () => deps.nukeBox(),
      openDesktop: () => deps.openBoxDesktop(),
      boxStoreStatus: () => deps.collectBoxStoreStatus(),
      boxStoreSnapshotNow: () => deps.snapshotBoxStoreNow(),
      boxStoreLogs: () => deps.boxStoreLogs(),
      boxStoreRecreateFresh: () => deps.runDevBoxScript("recreate-fresh"),
      boxStoreClear: () => deps.runDevBoxScript("clear-store")
    })
  };
}

// src/electron-main/dev/dev-controls-gate.ts
function isDevControlsEnabled(options) {
  return !options.isPackaged;
}
var DEFAULT_DEV_CONTROL_PORT = 62150;
function resolveDevControlPort(env = process.env) {
  const port = Number(env.SAND_DEV_CONTROL_PORT);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_DEV_CONTROL_PORT;
}

// src/shared/gateway-wire.ts
var GATEWAY_API_PREFIX = "/api";

// src/electron-main/dev/dev-host-upgrade-poke.ts
var POKE_TIMEOUT_MS = 3e4;
function formatHostUpgradePokeOutcome(result) {
  const version = typeof result.version === "string" ? result.version : "";
  const reason = typeof result.reason === "string" ? result.reason : "";
  if (result.started === true) {
    return {
      isOk: true,
      output: [
        "outcome: staged (real updateHostNow \u2014 fetch + stage OK)",
        version.length > 0 ? `to_version: ${version}` : void 0,
        "The supervisor hot-swaps the bundle at its next idle tick (forced) and emits sand.host.upgrade @phase:swap. Watch Box logs for the swap outcome."
      ].filter((line) => line != null).join("\n")
    };
  }
  if (reason === "already-latest") {
    return {
      isOk: true,
      output: `outcome: no-op \u2014 host already on latest${version.length > 0 ? ` (${version})` : ""}. Nothing to fetch/stage.`
    };
  }
  return {
    isOk: false,
    output: [
      "outcome: not started",
      `reason: ${reason.length > 0 ? reason : "(no reason returned)"}`
    ].join("\n")
  };
}
async function pokeHostUpgrade(deps) {
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const elapsedMs = () => now() - startedAt;
  if (deps.token == null || deps.token.length === 0) {
    return {
      isOk: false,
      exitCode: null,
      output: "No gateway token found (is the box up?).",
      durationMs: elapsedMs()
    };
  }
  const pokeDeadline = createDeadlinePolicy2({
    name: "dev-host-upgrade-poke",
    timeoutMs: deps.timeoutMs ?? POKE_TIMEOUT_MS
  });
  try {
    return await pokeDeadline.run(async (signal) => {
      const response = await fetchFn(`${deps.gatewayBaseUrl}${GATEWAY_API_PREFIX}/updateHostNow`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${deps.token}`,
          "Content-Type": "application/json"
        },
        // `force` escalates past the supervisor's idle-defer window (graceful
        // interrupt -> apply -> resume), matching the admin poke's default;
        // `includeErrorDetail` is the DEV-ONLY raw-error opt-in.
        body: JSON.stringify({ force: true, includeErrorDetail: true }),
        signal
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        return {
          isOk: false,
          exitCode: response.status,
          output: `updateHostNow HTTP ${response.status}${detail.length > 0 ? `
${detail}` : ""}`,
          durationMs: elapsedMs()
        };
      }
      const body = await response.json();
      const outcome = formatHostUpgradePokeOutcome(body);
      return {
        isOk: outcome.isOk,
        // A semantic failure (HTTP 200 but started:false, e.g. a @phase:fetch
        // failure) must not report `exit 0` in the OUTPUT footer — map it to a
        // non-zero code like the neighboring snapshot poke maps HTTP failures.
        exitCode: outcome.isOk ? 0 : 1,
        output: outcome.output,
        durationMs: elapsedMs()
      };
    });
  } catch (error) {
    return {
      isOk: false,
      exitCode: null,
      output: `updateHostNow request failed: ${String(error)}`,
      durationMs: elapsedMs()
    };
  }
}

// src/electron-main/dev/dev-controls-window.ts
var DEFAULT_CONTAINER_NAME = "sand-dev-box";
var DEFAULT_GATEWAY_URL = "http://127.0.0.1:1340";
var NOVNC_PORT = 6080;
var GATEWAY_PROBE_TIMEOUT_MS = 2e3;
var LOG_TAIL_LINES = 200;
var devControlsWindow;
function sandProjectDir() {
  return import_node_path5.default.resolve(__dirname, "..", "..");
}
var onePasswordCliDevController = createOnePasswordCliDevController({
  projectDir: sandProjectDir()
});
function devBoxScriptPath() {
  return import_node_path5.default.join(sandProjectDir(), "scripts", "dev-box-docker.mjs");
}
function containerName() {
  return process.env.SAND_DEV_BOX_CONTAINER ?? DEFAULT_CONTAINER_NAME;
}
function gatewayUrl() {
  const fromEnv = process.env.SAND_HOST_GATEWAY_URL?.trim();
  return fromEnv != null && fromEnv.length > 0 ? fromEnv : DEFAULT_GATEWAY_URL;
}
async function execCapture(command, args, options = {}) {
  const startedAt = Date.now();
  return await new Promise((resolve2) => {
    const child = (0, import_node_child_process3.spawn)(command, [...args], {
      cwd: sandProjectDir(),
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    const append = (chunk) => {
      output += chunk.toString();
      if (output.length > 2e5) {
        output = output.slice(output.length - 2e5);
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (error) => {
      resolve2({
        isOk: false,
        exitCode: null,
        output: `${output}
${String(error)}`.trim(),
        durationMs: Date.now() - startedAt
      });
    });
    child.on("close", (code) => {
      resolve2({
        isOk: code === 0,
        exitCode: code,
        output: output.trim(),
        durationMs: Date.now() - startedAt
      });
    });
  });
}
function devScriptEnv() {
  return { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
}
async function runDevBoxScript(subcommand, extraEnv = {}) {
  return await execCapture(process.execPath, [devBoxScriptPath(), subcommand], {
    env: { ...devScriptEnv(), ...extraEnv }
  });
}
async function isContainerRunning() {
  const result = await execCapture("docker", [
    "inspect",
    "-f",
    "{{.State.Running}}",
    containerName()
  ]);
  return result.isOk && result.output.trim() === "true";
}
var gatewayProbeDeadline = createDeadlinePolicy2({
  name: "dev-controls-gateway-probe",
  timeoutMs: GATEWAY_PROBE_TIMEOUT_MS
});
async function probeGateway() {
  const startedAt = Date.now();
  try {
    return await gatewayProbeDeadline.run(async (signal) => {
      const response = await fetch(`${gatewayUrl()}/health`, { signal });
      const latencyMs = Date.now() - startedAt;
      if (!response.ok) {
        return { isReachable: false, isBusy: false, latencyMs };
      }
      let isBusy = false;
      try {
        const body = await response.json();
        isBusy = body.isBusy === true;
      } catch (error) {
        reportDesktopEdgeFailure("dev-controls", "health-body", error);
      }
      return { isReachable: true, isBusy, latencyMs };
    });
  } catch {
    return { isReachable: false, isBusy: false, latencyMs: null };
  }
}
async function collectBoxStatus() {
  const [isRunning, gateway] = await Promise.all([isContainerRunning(), probeGateway()]);
  let detail;
  if (!isRunning) {
    detail = "Container not running";
  } else if (!gateway.isReachable) {
    detail = "Container up, gateway not reachable yet";
  } else {
    detail = `Gateway healthy${gateway.isBusy ? " (host busy)" : ""}`;
  }
  return {
    containerName: containerName(),
    isContainerRunning: isRunning,
    gatewayUrl: gatewayUrl(),
    isGatewayReachable: gateway.isReachable,
    isHostBusy: gateway.isBusy,
    latencyMs: gateway.latencyMs,
    detail
  };
}
function parseBoxDoctorOutput(raw) {
  const checks = [];
  let summary = "";
  for (const line of raw.split("\n")) {
    const checkMatch = /^\[box-doctor\]\s+(PASS|FAIL)\s+([^:]+):\s*(.*)$/.exec(line.trim());
    if (checkMatch != null) {
      checks.push({
        isPass: checkMatch[1] === "PASS",
        name: checkMatch[2].trim(),
        detail: checkMatch[3].trim()
      });
      continue;
    }
    const summaryMatch = /^\[box-doctor\]\s+SUMMARY:\s*(.*)$/.exec(line.trim());
    if (summaryMatch != null) {
      summary = summaryMatch[1].trim();
    }
  }
  return {
    isOk: checks.length > 0 && checks.every((check) => check.isPass),
    checks,
    summary,
    raw
  };
}
async function collectBoxHealth() {
  if (!await isContainerRunning()) {
    return {
      isOk: false,
      checks: [],
      summary: `Container ${containerName()} is not running`,
      raw: ""
    };
  }
  const result = await execCapture("docker", ["exec", containerName(), "box-doctor"]);
  const health = parseBoxDoctorOutput(result.output);
  if (health.checks.length > 0) return health;
  return {
    isOk: false,
    checks: [],
    summary: result.output.length > 0 ? "box-doctor produced no checks" : "box-doctor failed",
    raw: result.output
  };
}
function devBoxRootHost() {
  return import_node_path5.default.join(getSandRootDir(), "dev-box");
}
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
async function collectBoxStoreStatus() {
  const root = devBoxRootHost();
  let storeId = null;
  try {
    storeId = (await (0, import_promises.readFile)(import_node_path5.default.join(root, "box-store-id"), "utf8")).trim() || null;
  } catch {
    storeId = null;
  }
  let manifestEntries = 0;
  let totalBytes = 0;
  let lastSnapshotMsAgo = null;
  if (storeId != null) {
    try {
      const parsed = JSON.parse(
        await (0, import_promises.readFile)(import_node_path5.default.join(root, "box-store", storeId, "manifest.json"), "utf8")
      );
      const entries = parsed.entries ?? {};
      manifestEntries = Object.keys(entries).length;
      for (const entry of Object.values(entries)) {
        if (typeof entry.size === "number" && entry.size > 0) {
          totalBytes += entry.size;
        }
      }
      if (typeof parsed.updatedAtMs === "number" && parsed.updatedAtMs > 0) {
        lastSnapshotMsAgo = Math.max(0, Date.now() - parsed.updatedAtMs);
      }
    } catch (error) {
      reportDesktopEdgeFailure("dev-controls", "snapshot-manifest", error);
    }
  }
  const copyInOutcome = await readCopyInOutcome();
  let detail;
  if (storeId == null) {
    detail = "Store not configured (run dev:box)";
  } else if (lastSnapshotMsAgo == null) {
    detail = "No snapshot yet";
  } else {
    detail = `${manifestEntries} files, ${formatBytes(totalBytes)}`;
  }
  return {
    isStoreEnabled: storeId != null,
    lastSnapshotMsAgo,
    manifestEntries,
    totalBytes,
    copyInOutcome,
    detail
  };
}
async function readCopyInOutcome() {
  if (!await isContainerRunning()) return "unknown";
  const result = await execCapture("docker", [
    "exec",
    containerName(),
    "sh",
    "-c",
    "cat /tmp/sand-copy-in.log 2>/dev/null || true"
  ]);
  const matches = [...result.output.matchAll(/\[box-copy-in\] result outcome=(\S+)/g)];
  return matches.length > 0 ? matches[matches.length - 1][1] : "none";
}
async function readGatewayToken() {
  const fromEnv = process.env.SAND_HOST_GATEWAY_TOKEN?.trim();
  if (fromEnv != null && fromEnv.length > 0) return fromEnv;
  try {
    const parsed = JSON.parse(
      await (0, import_promises.readFile)(import_node_path5.default.join(devBoxRootHost(), "gateway.json"), "utf8")
    );
    return parsed.gatewayToken ?? null;
  } catch {
    return null;
  }
}
async function snapshotBoxStoreNow() {
  const startedAt = Date.now();
  const token = await readGatewayToken();
  if (token == null) {
    return {
      isOk: false,
      exitCode: null,
      output: "No gateway token found (is the box up?).",
      durationMs: Date.now() - startedAt
    };
  }
  try {
    const response = await fetch(`${gatewayUrl()}/api/snapshotBoxStoreNow`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ includeIdleOnly: false })
    });
    const text = await response.text();
    return {
      isOk: response.ok,
      exitCode: response.ok ? 0 : response.status,
      output: text.length > 0 ? text : `HTTP ${response.status}`,
      durationMs: Date.now() - startedAt
    };
  } catch (error) {
    return {
      isOk: false,
      exitCode: null,
      output: String(error),
      durationMs: Date.now() - startedAt
    };
  }
}
async function postControl(pathname) {
  try {
    await fetch(`http://127.0.0.1:${resolveDevControlPort()}${pathname}`, {
      method: "POST"
    });
  } catch (error) {
    reportDesktopEdgeFailure("dev-controls", "control-post", error);
  }
}
var SandDevThemeControlError = class extends Error {
};
async function fetchTheme(search) {
  const response = await fetch(`http://127.0.0.1:${resolveDevControlPort()}/theme${search}`, {
    method: search.length === 0 ? "GET" : "POST"
  });
  const body = await response.json();
  if (!response.ok || !isSandThemeState(body)) {
    throw new SandDevThemeControlError(`theme control failed: HTTP ${response.status}`);
  }
  return body;
}
var SandDevGatewayOfflineControlError = class extends Error {
};
async function fetchGatewayOffline(search) {
  const response = await fetch(
    `http://127.0.0.1:${resolveDevControlPort()}/gateway-offline${search}`,
    { method: search.length === 0 ? "GET" : "POST" }
  );
  const body = await response.json();
  if (!response.ok || typeof body.induced !== "boolean") {
    throw new SandDevGatewayOfflineControlError(
      typeof body.error === "string" ? body.error : `gateway-offline control failed: HTTP ${response.status}`
    );
  }
  return { induced: body.induced };
}
async function tailBoxLogs() {
  if (!await isContainerRunning()) {
    return {
      isOk: false,
      exitCode: null,
      output: `Container ${containerName()} is not running.`,
      durationMs: 0
    };
  }
  return await execCapture("docker", [
    "exec",
    containerName(),
    "sh",
    "-c",
    // The host's stdout rides its own /tmp/sand-host.log (split out by the
    // supervisor); show both so the in-box host + supervisor are together.
    `touch /tmp/sand-supervisor.log /tmp/sand-host.log; tail -n ${LOG_TAIL_LINES} /tmp/sand-supervisor.log /tmp/sand-host.log`
  ]);
}
async function readBoxStoreLogs() {
  if (!await isContainerRunning()) {
    return {
      isOk: false,
      exitCode: null,
      output: `Container ${containerName()} is not running.`,
      durationMs: 0
    };
  }
  return await execCapture("docker", [
    "exec",
    containerName(),
    "sh",
    "-c",
    `touch /tmp/sand-host.log /tmp/sand-copy-in.log; grep -hF -e '[box-store-sync]' -e '[box-copy-in]' /tmp/sand-host.log /tmp/sand-copy-in.log | tail -n ${LOG_TAIL_LINES}`
  ]);
}
async function nukeBox() {
  return await execCapture("bash", [import_node_path5.default.join(sandProjectDir(), "box", "nuke-sand-box.sh")]);
}
async function openBoxDesktop() {
  const url = new URL(gatewayUrl());
  url.port = String(NOVNC_PORT);
  url.pathname = "/vnc.html";
  await import_electron.shell.openExternal(url.toString());
}
function isDevControlsPanelSender(sender) {
  return devControlsWindow != null && !devControlsWindow.isDestroyed() && sender === devControlsWindow.webContents;
}
function devControlsEdgeTransport() {
  return {
    handle: (channel, run) => {
      import_electron.ipcMain.handle(
        channel,
        (event, payload) => run({ isDevControlsPanel: isDevControlsPanelSender(event.sender) }, payload)
      );
    },
    removeHandler: (channel) => {
      import_electron.ipcMain.removeHandler(channel);
    },
    broadcast: () => {
    }
  };
}
function serveDevControlsEdge() {
  serveEdge(devControlsRpcContract, DEV_CONTROLS_METHOD_TABLE, {
    transport: devControlsEdgeTransport(),
    trust: createDevControlsTrust(),
    handlers: createDevControlsHandlers({
      postControl,
      fetchTheme,
      fetchGatewayOffline,
      collectBoxStatus,
      collectBoxHealth,
      runDevBoxScript,
      // The REAL in-box host-upgrade poke (distinct from "Upgrade host", which is
      // the local dev-loop bundle sync): drives the same `/api/updateHostNow` gateway
      // command the backend admin "Update host" uses, so the in-box host genuinely
      // resolves + fetches the published bundle from S3 and stages it for the
      // supervisor swap. Like the snapshot-flush poke, it targets the LOCAL dev box via
      // the same loopback gateway descriptor (`gatewayUrl()` + `readGatewayToken()`);
      // the brokered "Attach prod box" path is not reached by the panel's gateway pokes
      // (the panel is a separate process without the main app's brokered connection /
      // pod-network token), and the host's raw-error gate refuses a prod box regardless.
      pokeHostUpgrade: async () => await pokeHostUpgrade({
        gatewayBaseUrl: gatewayUrl(),
        token: await readGatewayToken()
      }),
      tailBoxLogs,
      nukeBox,
      openBoxDesktop,
      collectBoxStoreStatus,
      snapshotBoxStoreNow,
      boxStoreLogs: readBoxStoreLogs,
      getAttachProdBoxStatus: () => getAttachProdBoxStatus(),
      writeAttachProdBoxPrefs: (enabled) => {
        writeAttachProdBoxPrefs(enabled);
      },
      onePasswordCli: onePasswordCliDevController
    })
  });
}
function openDevControlsWindow() {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl == null || devServerUrl.length === 0) return;
  if (devControlsWindow != null && !devControlsWindow.isDestroyed()) {
    devControlsWindow.focus();
    return;
  }
  const width = 780;
  const height = 600;
  const margin = 16;
  const { workArea } = import_electron.screen.getPrimaryDisplay();
  const window = new import_electron.BrowserWindow({
    width,
    height,
    minWidth: 660,
    minHeight: 460,
    x: workArea.x + workArea.width - width - margin,
    y: workArea.y + margin,
    title: "Grok Bot Dev Controls",
    resizable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: false,
    backgroundColor: "#0f1117",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // The panel entry (electron-dev-controls/main.cts) bundles this module
      // and runs from dist/electron-dev-controls, so the panel preload
      // resolves from the sibling dist/electron-preload dir — the same shape
      // the main window uses for its preloads.
      preload: import_node_path5.default.join(__dirname, "..", "electron-preload", "preload-dev-controls.cjs"),
      sandbox: false
    }
  });
  window.setMenuBarVisibility(false);
  devControlsWindow = window;
  window.on("closed", () => {
    devControlsWindow = void 0;
  });
  const target = new URL(
    "src/electron-dev-controls/page/dev-controls.html",
    devServerUrl.endsWith("/") ? devServerUrl : `${devServerUrl}/`
  ).href;
  void window.loadURL(target);
}

// src/host/process-crash-guard.ts
function toError(value) {
  return value instanceof Error ? value : new Error(String(value));
}
function handleProcessCrash(options, kind, value) {
  const error = toError(value);
  console.error(`[${options.scope}] ${kind} (kept alive):`, error);
  try {
    options.onError?.(error, kind);
  } catch {
  }
}
function installProcessCrashGuards(options) {
  let reporter2 = options.onError;
  const report = (kind, value) => handleProcessCrash({ scope: options.scope, onError: reporter2 }, kind, value);
  process.on("uncaughtException", (value) => report("uncaughtException", value));
  process.on("unhandledRejection", (value) => report("unhandledRejection", value));
  return {
    setReporter: (onError) => {
      reporter2 = onError;
    }
  };
}

// src/electron-dev-controls/main.cts
installProcessCrashGuards({ scope: "sand-dev-controls" });
if (!isDevControlsEnabled({ isPackaged: import_electron2.app.isPackaged })) {
  import_electron2.app.quit();
} else {
  const isPrimaryInstance = import_electron2.app.requestSingleInstanceLock();
  if (!isPrimaryInstance) {
    import_electron2.app.quit();
  } else {
    import_electron2.app.on("second-instance", () => {
      openDevControlsWindow();
    });
    void import_electron2.app.whenReady().then(() => {
      serveDevControlsEdge();
      openDevControlsWindow();
    });
    import_electron2.app.on("window-all-closed", () => {
      import_electron2.app.quit();
    });
  }
}
//# sourceMappingURL=main.cjs.map
