"use strict";

var PNG = require('./PNG');
var zlib = require('zlib');

function equalBytes(a, b){
	if (a.length != b.length) return false;
	for (var l = a.length; l--;) if (a[l] != b[l]) return false;
	return true;
}

function readUInt32(buffer, offset){
	return (buffer[offset] << 24) +
		(buffer[offset + 1] << 16) +
		(buffer[offset + 2] << 8) +
		(buffer[offset + 3] << 0);
}

function readUInt16(buffer, offset){
	return (buffer[offset + 1] << 8) + (buffer[offset] << 0);
}

function readUInt8(buffer, offset){
	return buffer[offset] << 0;
}

function bufferToString(buffer){
	var str = '';
	for (var i = 0; i < buffer.length; i++){
		str += String.fromCharCode(buffer[i]);
	}
	return str;
}

var PNGReader = function(bytes){

	if (typeof bytes == 'string'){
		var bts = bytes;
		bytes = new Array(bts.length);
		for (var i = 0, l = bts.length; i < l; i++){
			bytes[i] = bts[i].charCodeAt(0);
		}
	}

	// current pointer
	this.i = 0;
	// bytes buffer
	this.bytes = bytes;
	// Output object
	this.png = new PNG();

	this.imgData = [];

};

PNGReader.prototype.readBytes = function(length){
	var end = this.i + length;
	if (end > this.bytes.length){
		throw new Error('Unexpectedly reached end of file');
	}
	var bytes = this.bytes.slice(this.i, end);
	this.i = end;
	return bytes;
};

/**
 * http://www.w3.org/TR/2003/REC-PNG-20031110/#5PNG-file-signature
 */
PNGReader.prototype.decodeHeader = function(){

	if (this.i !== 0){
		throw new Error('file pointer should be at 0 to read the header');
	}

	var header = this.readBytes(8);

	if (!equalBytes(header, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])){
		throw new Error('invalid PNGReader file (bad signature)');
	}

	this.header = header;

};

/**
 * http://www.w3.org/TR/2003/REC-PNG-20031110/#5Chunk-layout
 *
 * length =  4      bytes
 * type   =  4      bytes (IHDR, PLTE, IDAT, IEND or others)
 * chunk  =  length bytes
 * crc    =  4      bytes
 */
PNGReader.prototype.decodeChunk = function(){

	var length = readUInt32(this.readBytes(4), 0);

	if (length < 0){
		throw new Error('Bad chunk length ' + (0xFFFFFFFF & length));
	}

	var type = bufferToString(this.readBytes(4));
	var chunk = this.readBytes(length);
	var crc = this.readBytes(4);

	switch (type){
		case 'IHDR': this.decodeIHDR(chunk); break;
		case 'PLTE': this.decodePLTE(chunk); break;
		case 'IDAT': this.decodeIDAT(chunk); break;
		case 'IEND': this.decodeIEND(chunk); break;
	}

	return type;

};

/**
 * http://www.w3.org/TR/2003/REC-PNG-20031110/#11IHDR
 * http://www.libpng.org/pub/png/spec/1.2/png-1.2-pdg.html#C.IHDR
 *
 * Width               4 bytes
 * Height              4 bytes
 * Bit depth           1 byte
 * Colour type         1 byte
 * Compression method  1 byte
 * Filter method       1 byte
 * Interlace method    1 byte
 */
PNGReader.prototype.decodeIHDR = function(chunk){
	var png = this.png;

	png.setWidth(             readUInt32(chunk, 0));
	png.setHeight(            readUInt32(chunk, 4));
	png.setBitDepth(          readUInt8(chunk,  8));
	png.setColorType(         readUInt8(chunk,  9));
	png.setCompressionMethod( readUInt8(chunk, 10));
	png.setFilterMethod(      readUInt8(chunk, 11));
	png.setInterlaceMethod(   readUInt8(chunk, 12));

};

/**
 *
 * http://www.w3.org/TR/PNG/#11PLTE
 */
PNGReader.prototype.decodePLTE = function(chunk){
	this.png.setPalette(chunk);
};

/**
 * http://www.w3.org/TR/2003/REC-PNG-20031110/#11IDAT
 */
PNGReader.prototype.decodeIDAT = function(chunk){
	// multiple IDAT chunks are concatenated
	for (var i = 0; i < chunk.length; i++){
		this.imgData.push(chunk[i]);
	}
};

/**
 * http://www.w3.org/TR/2003/REC-PNG-20031110/#11IEND
 */
PNGReader.prototype.decodeIEND = function(){
};

/**
 * Uncompress IDAT chunks
 */
PNGReader.prototype.decodePixels = function(callback){
	var png = this.png;
	var reader = this;
	zlib.inflate(new Buffer(this.imgData), function(err, data){
		if (err) throw err;

		if (png.getInterlaceMethod() === 0){
			reader.interlaceNone(data);
		} else {
			reader.interlaceAdam7(data);
		}

		callback();

	});
};

// Different interlace methods

PNGReader.prototype.interlaceNone = function(data){

	var png = this.png;

	// bytes per pixel
	var bpp = Math.max(1, png.colors * png.bitDepth / 8);

	// color bytes per row
	var cpr = bpp * png.width;

	var pixels = new Buffer(bpp * png.width * png.height);
	var scanline;
	var offset = 0;

	for (var i = 0; i < data.length; i += cpr + 1){

		scanline = data.slice(i + 1, i + cpr + 1);

		switch (readUInt8(data, i)){
			case 0: this.unFilterNone(   scanline, pixels, bpp, offset, cpr); break;
			case 1: this.unFilterSub(    scanline, pixels, bpp, offset, cpr); break;
			case 2: this.unFilterUp(     scanline, pixels, bpp, offset, cpr); break;
			case 3: this.unFilterAverage(scanline, pixels, bpp, offset, cpr); break;
			case 4: this.unFilterPaeth(  scanline, pixels, bpp, offset, cpr); break;
			default: throw new Error("unkown filtered scanline");
		}

		offset += cpr;

	}

	png.pixels = pixels;

};

PNGReader.prototype.interlaceAdam7 = function(data){
	throw new Error("Adam7 interlacing is not implemented yet");
};

// Unfiltering

/**
 * No filtering, direct copy
 */
PNGReader.prototype.unFilterNone = function(scanline, pixels, bpp, of, length){
	for (var i = 0, to = length; i < to; i++){
		pixels[of + i] = scanline[i];
	}
};

/**
 * The Sub() filter transmits the difference between each byte and the value
 * of the corresponding byte of the prior pixel.
 * Sub(x) = Raw(x) + Raw(x - bpp)
 */
PNGReader.prototype.unFilterSub = function(scanline, pixels, bpp, of, length){
	for (var i = 0; i < length; i++){
		// Raw(x)
		var byte = scanline[i];
		// Raw(x - bpp)
		var prev = (i - bpp) < 0 ? 0 : pixels[of + i - bpp];
		pixels[of + i] = (byte + prev) & 0xFF;
	}
};

/**
 * The Up() filter is just like the Sub() filter except that the pixel
 * immediately above the current pixel, rather than just to its left, is used
 * as the predictor.
 * Up(x) = Raw(x) + Prior(x)
 */
PNGReader.prototype.unFilterUp = function(scanline, pixels, bpp, of, length){
	var i = 0, byte, prev;
	// Prior(x) is 0 for all x on the first scanline
	for (; i < length; i++){
		// Raw(x)
		byte = scanline[i];
		// Prior(x)
		prev = (of + i - length) < 0 ? 0 : pixels[of + i - length];
		pixels[of + i] = (byte + prev) & 0xFF;
	}
};

/**
 * The Average() filter uses the average of the two neighboring pixels (left
 * and above) to predict the value of a pixel.
 * Average(x) = Raw(x) + floor((Raw(x-bpp)+Prior(x))/2)
 */
PNGReader.prototype.unFilterAverage = function(scanline, pixels, bpp, of, length){
	var i = 0, byte, prev, prior;
	for (; i < length; i++){
		// Raw(x)
		byte = scanline[i];
		// Raw(x - bpp), Assume Raw(x) = 0 for x < 0
		prev = (i - bpp) < 0 ? 0 : pixels[of + i - bpp];
		prior = (of + i - length) < 0 ? 0 : pixels[of + i - length];
		// right shift, prevent doubles by not using the / operator
		pixels[of + i] = (byte + (prev + prior) >> 1) & 0xFF;
	}
};

/**
 * The Paeth() filter computes a simple linear function of the three
 * neighboring pixels (left, above, upper left), then chooses as predictor
 * the neighboring pixel closest to the computed value. This technique is due
 * to Alan W. Paeth.
 * Paeth(x) = Raw(x) +
 *            PaethPredictor(Raw(x-bpp), Prior(x), Prior(x-bpp))
 *  function PaethPredictor (a, b, c)
 *  begin
 *       ; a = left, b = above, c = upper left
 *       p := a + b - c        ; initial estimate
 *       pa := abs(p - a)      ; distances to a, b, c
 *       pb := abs(p - b)
 *       pc := abs(p - c)
 *       ; return nearest of a,b,c,
 *       ; breaking ties in order a,b,c.
 *       if pa <= pb AND pa <= pc then return a
 *       else if pb <= pc then return b
 *       else return c
 *  end
 */
PNGReader.prototype.unFilterPaeth = function(scanline, pixels, bpp, of, length){
	var i = 0, raw, a, b, c, p, pa, pb, pc, pr;
	for (; i < length; i++){
		// Raw(x)
		raw = scanline[i];
		// a = Raw(x-bpp)
		a = (i - bpp) < 0 ? 0 : pixels[of + i - bpp];
		// b = Prior(x)
		b = (of + i - length) < 0 ? 0 : pixels[of + i - length];
		// c = Prior(x-bpp)
		c = (i - bpp) < 0 ? 0 : pixels[of + i - length - bpp];
		// pr = PaethPredictor(a, b, c)
		p = a + b - c;
		pa = Math.abs(p - a);
		pb = Math.abs(p - b);
		pc = Math.abs(p - c);
		if (pa <= pb && pa <= pc) pr = a;
		else if (pb <= pc) pr = b;
		else pr = c;
		pixels[of + i] = (raw + pr) & 0xFF;
	}
};

/**
 * Parse the PNG file
 *
 * reader.parse(options, callback)
 * OR
 * reader.parse(callback)
 *
 * OPTIONS:
 *    option  | type     | default
 *    ----------------------------
 *    data      boolean    true    should it read the pixel data
 */
PNGReader.prototype.parse = function(options, callback){

	if (typeof options == 'function') callback = options;
	if (typeof options != 'object') options = {};

	this.decodeHeader();

	while (this.i < this.bytes.length){
		var type = this.decodeChunk();
		// stop after IHDR chunk, or after IEND
		if (type == 'IHDR' && options.data === false || type == 'IEND') break;
	}

	var png = this.png;

	this.decodePixels(function(){
		callback(png);
	});

};

module.exports = PNGReader;
