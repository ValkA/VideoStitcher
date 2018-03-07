/**
 * Created by valentid on 06/02/2018.
 */
"use strict";
var fs = require("fs");
var promiseLimit = require('promise-limit')
var ffmpeg = require("fluent-ffmpeg");
var SpeechToTextV1 = require("watson-developer-cloud/speech-to-text/v1");
var program = require('commander');

const debug = true;

//make needed folders
const trimmedPath = './trimmed/';

try {fs.mkdirSync('./words');} catch (e) {if(e.code !== "EEXIST") throw(e);}
try {fs.mkdirSync(trimmedPath);} catch (e) {if(e.code !== "EEXIST") throw(e);}
try {fs.mkdirSync('./results');} catch (e) {if(e.code !== "EEXIST") throw(e);}
try {fs.mkdirSync('./normalizedVideos');} catch (e) {if(e.code !== "EEXIST") throw(e);}
try {fs.mkdirSync('./videos');} catch (e) {if(e.code !== "EEXIST") throw(e);}
try {fs.mkdirSync('./tmp');} catch (e) {if(e.code !== "EEXIST") throw(e);}

var config = require('./config.json');
var speech_to_text = new SpeechToTextV1(config);

/**
 * Takes videos from ./videos/ folder and converts them all to same resolution,fps and codec.
 * Normalized videos are saved to ./normalizedVideos/
 * limits to 4 processes (4 videos are processed in parallel)
 * @returns {*}
 */
function normalizeVideos(){
    let limit = promiseLimit(4);
    let newVideos = fs.readdirSync('./videos').filter((filename)=>{
        return (filename[0] !== '_') && (filename[0] !== '.');
    });

    if(newVideos.length == 0) return Promise.resolve();

    return limit.map(newVideos, (newVideo)=> {
        return new Promise((resolve, reject) => {
            let normalizer = ffmpeg("./videos/"+newVideo)
                .size('640x480')
                .autoPad()
                .audioCodec('libmp3lame')
                .audioFrequency(44100)
                .outputFps(30)
                .videoCodec('libx264')
                .on('start', (cmd)=>{
                    if (debug) console.log("Normalizing " + newVideo);
                })
                .on('end', ()=>{
                    fs.renameSync('./videos/'+newVideo, './videos/_'+newVideo);
                    // if (debug) console.log("Normalizing " + word + ".mp4");
                    return resolve();
                })
                .on('error', (err, stdout, stderr)=>{
                    console.error("Cant normalize " + newVideo + " the error is" + err)
                    return resolve(err);
                })
                .output('./normalizedVideos/'+newVideo);
            normalizer.run();
        });
    });
}

/**
 * Takes all ./normalizedVideos/${filename} and pipes their audio stream to the STT engine.
 * Eventually ${filename}.json is created for each ${filename} in ./words/ folder
 * @returns {*}
 */
function videosToText() {
    let filenames = fs.readdirSync('./normalizedVideos/').filter((f)=>{return f.substring(f.length-4,f.length)==='.mp4'});
    return filenames.reduce((promise, filename)=>{
        return promise.then((dict)=>{
            return new Promise((resolve, reject)=>{
                try {
                    let newDict = require("./words/"+filename+".json");
                    Object.assign(dict, newDict);
                    if(debug) console.log('Using "./words/'+filename+'.json", no need to call IBM\'s STT');
                    return resolve(dict);
                }
                catch (e) {
                    console.log("Creating ./words/"+filename+".json, thanks to IBM's STT")
                }

                let videoEncoder = ffmpeg('./normalizedVideos/'+filename)
                    .seekInput('0:00')
                    .format('mp3')
                    .audioBitrate('64k')
                    .audioChannels(1)
                    .audioCodec('libmp3lame')
                    .noVideo()
                    // .withDuration(30)
                    .on('start', (cmd)=>{
                        // if(debug) console.log('Started ' + cmd);
                    })
                    .on('progress', (progress)=>{
                        // stripBar.tick(progress.percent);
                    })
                    .on('end', ()=>{
                        if(debug) console.log("Converted " + filename + " to mp3\n");
                    })
                    .on('error', (err, stdout, stderr)=>{
                        return reject(err);
                    });

                let recognizeStream = speech_to_text.createRecognizeStream({
                    model: 'en-US_BroadbandModel',
                    interim_results: debug,
                    // word_confidence: true,
                    timestamps: true,
                    // speaker_labels: true,
                    // readableObjectMode: true,
                    objectMode: true,
                    max_alternatives: 0

                });
                let newDict = {};
                recognizeStream.on("data", (event)=>{
                    if(!event.results || !event.results[0]) {return;}
                    if(!event.results[0].final){
                        if(debug) {
                            process.stdout.write('\x1B[2J\x1B[0f');
                            process.stdout.write(event.results[0].alternatives[0].transcript);
                            process.stdout.write('\n');
                        }
                        return;
                    }

                    event.results[0].alternatives[0].timestamps.forEach((wordTriple)=>{
                        //TODO: do multimap and sort by confidence
                        newDict[wordTriple[0]]={
                            startTime: wordTriple[1],
                            endTime: wordTriple[2],
                            filename: filename
                        }
                    });
                });

                recognizeStream.on("close", ()=> {
                    process.stdout.write('\x1B[2J\x1B[0f');
                    if(debug) console.log("Extracted " + Object.keys(newDict).length + " words from " + filename);
                    fs.writeFileSync("./words/"+filename+".json", JSON.stringify(newDict));
                    Object.assign(dict, newDict);
                    resolve(dict)
                });

                videoEncoder.pipe(recognizeStream, { end: true })
            });
        });
    }, Promise.resolve({}));
}

function getTrimmedVideos(){
    return fs.readdirSync(trimmedPath).reduce((rv,f)=>{
        rv[f] = true;
        return rv;
    }, {});
}

function wordToTrimmedVideoName(word){
    return word + '.mp4';
}

function wordToTrimmedVideoPath(word){
    return trimmedPath + wordToTrimmedVideoName(word);
}

/**
 * Gets a dictionary, and trims videos according to words.
 * Trimmed videos are saved in ./trimmed/
 * @param dict - an aggregation of json objects from ./words/
 * @returns {*}
 */
function trimVideos(dict){
    //4 parallel promises (and each promise is a process here...)
    let limit = promiseLimit(4);
    let existingTrimmedVideos = getTrimmedVideos();

    return limit.map(Object.keys(dict), (word)=> {
        return new Promise((resolve, reject) => {
            let trimmedVideoPath = wordToTrimmedVideoPath(word);
            if (existingTrimmedVideos[wordToTrimmedVideoName(word)]) {
                // if (debug) console.log("Trimmed file " + trimmedVideoPath + " exists, skipping");
                return resolve();
            }

            let wordObject = dict[word];
            let trimmer = ffmpeg("./normalizedVideos/"+wordObject.filename)
                .seekInput(wordObject.startTime)
                .withDuration(wordObject.endTime - wordObject.startTime)
                .on('start', (cmd)=>{
                    if (debug) console.log("Trimming " + word + ".mp4");
                })
                .on('end', ()=>{
                    // if (debug) console.log("Trimmed " + word + ".mp4");
                    return resolve();
                })
                .on('error', (err, stdout, stderr)=>{
                    return reject(err);
                })
                .output(trimmedVideoPath);
            trimmer.run();
        });
    });
}

/**
 *
 * @param text - the text that you want to compose a video for
 * @param filename
 * @returns {Promise}
 */
function stitchVideos(text, filename) {
    return new Promise((resolve, reject) => {
        let existingTrimmedVideos = getTrimmedVideos();
        let stitcher = ffmpeg()
            .on('start', (cmd) => {
                if (debug) console.log("Stitching " + filename);
            })
            .on('end', () => {
                if (debug) console.log("Done !");
                return resolve();
            })
            .on('error', (err, stdout, stderr) => {
                return reject(err);
            });

        text.split(' ').forEach((word) => {
            if (!existingTrimmedVideos[wordToTrimmedVideoName(word)]) {
                console.log("Stitcher haven't found video for the word " + word + " was found putting 'sex' instead");
                stitcher.input(wordToTrimmedVideoPath("sex"));
                return;
            }
            stitcher.input(wordToTrimmedVideoPath(word));
            if (debug) console.log("Stitcher found " + wordToTrimmedVideoPath(word));
        });

        stitcher.mergeToFile('./results/'+filename+'.mp4', './tmp/')
        try{stitcher.run();}catch(e){}//ugly way to supress strange error..
    });
}

let txt = "pullng girl sex girl sex girl Walter sex girl sex girl sex Walter girl sex girl sex body sex broken sex boy sex girl sex boy sex girl sex boy sex girl";
normalizeVideos().then(videosToText).then(trimVideos).then(()=>{return stitchVideos(txt ,"first_test_2")}).catch((e)=>{console.log(e);});

program
    .version('0.1.0')
    .option('-p, --peppers', 'Add peppers')
    .option('-P, --pineapple', 'Add pineapple')
    .option('-b, --bbq-sauce', 'Add bbq sauce')
    .option('-c, --cheese [type]', 'Add the specified type of cheese [marble]', 'marble')
    .parse(process.argv);


