import React, { useState, useEffect, useRef } from "react"; // Import useState
import { Button, Input } from "antd";
import { AudioOutlined } from "@ant-design/icons";
import SpeechRecognition, {
  useSpeechRecognition,
} from "react-speech-recognition";
import Speech from "speak-tts";

const { Search } = Input;

const DOMAIN = "http://localhost:5001";

const searchContainer = {
  display: "flex",
  justifyContent: "center",
};

const ChatComponent = (props) => {
  const { onStart, onDelta, onError, isLoading, setIsLoading } = props;
  // Define a state variable to keep track of the search value
  const [searchValue, setSearchValue] = useState("");

  const [isChatModeOn, setIsChatModeOn] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [speech, setSpeech] = useState();
  const onSearchRef = useRef(null);

  // speech recognation
  const {
    transcript,
    listening,
    resetTranscript,
  } = useSpeechRecognition();

  useEffect(() => {
    const initializedSpeech = new Speech();
    initializedSpeech
      .init({
        volume: 1,
        lang: "en-US",
        rate: 1,
        pitch: 1,
        // 不写死 voice：各浏览器/系统可用语音不同（macOS 没有 "Google US English"），
        // 且 voices 是异步加载的，init 时指定具体语音常会报
        // "voice is not valid / not loaded"。留空用系统默认语音最稳。
        splitSentences: true,
      })
      .then(() => {
        // init() resolve 出来的是配置对象（voices/lang/... ），不是带 speak() 的实例。
        // 要存实例本身，否则后面 speech.speak(...) 会报 "speak is not a function"。
        setSpeech(initializedSpeech);
      })
      .catch((error) => {
        console.error(`Error initializing speech: ${error}`);
      });
  }, []);

  const talk = (what2say) => {
    speech
      .speak({
        text: what2say,
        queue: false, // current speech will be interrupted,
        listeners: {
          onstart: () => {
            console.log("Start utterance");
          },
          onend: () => {
            console.log("End utterance");
          },
          onresume: () => {
            console.log("Resume utterance");
          },
          onboundary: (event) => {
            console.log(
              event.name +
                " boundary reached after " +
                event.elapsedTime +
                " milliseconds.",
            );
          },
        },
      })
      .then(() => {
        // if everyting went well, start listening again
        console.log("Success !");
        userStartConvo();
      })
      .catch((e) => {
        console.error("An error occurred :", e);
      });
  };

  const userStartConvo = () => {
    SpeechRecognition.startListening();
    setIsRecording(true);
    resetTranscript();
  };

  const chatModeClickHandler = () => {
    setIsChatModeOn(!isChatModeOn);
    setIsRecording(false);
    SpeechRecognition.stopListening();

    resetTranscript();
  };

  const recordingClickHandler = () => {
    if (isRecording) {
      SpeechRecognition.stopListening();
      setIsRecording(false);
    } else {
      setIsRecording(true);
      SpeechRecognition.startListening();
    }
  };

  const onSearch = async (question) => {
    // 正在请求中或问题为空时直接忽略，防止反复点击/回车并发提交
    if (isLoading || !question.trim()) return;

    // Clear the search input
    setSearchValue("");
    setIsLoading(true);
    onStart(question); // 先放一条空气泡，后续逐字填充

    // 打字机效果：网络上 token 是一块块到的（一次蹦出整个词），
    // 这里先入队，再用定时器按字符匀速吐出，跟到达节奏解耦，显示更平滑。
    let queue = "";
    let streamDone = false;
    const timer = setInterval(() => {
      if (queue.length > 0) {
        // 积压越多每次吐越多个字符，避免落后网络太远
        const step = Math.max(1, Math.ceil(queue.length / 30));
        onDelta(queue.slice(0, step));
        queue = queue.slice(step);
      } else if (streamDone) {
        clearInterval(timer);
        setIsLoading(false);
      }
    }, 16);

    try {
      const response = await fetch(
        `${DOMAIN}/chat?question=${encodeURIComponent(question)}`,
      );
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullText = ""; // 累积完整答案，流结束后用于语音播报

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE 事件以空行(\n\n)分隔，保留最后一段不完整的留到下次
        const events = buffer.split("\n\n");
        buffer = events.pop();
        for (const evt of events) {
          const line = evt.replace(/^data: /, "").trim();
          if (!line) continue;
          const data = JSON.parse(line);
          if (data.delta) {
            queue += data.delta; // 入队，交给定时器逐字吐出
            fullText += data.delta;
          } else if (data.error) onError(data.error);
        }
      }

      // 流式下 response 是 fetch Response，没有 .data；答案在 fullText 里
      if (isChatModeOn && fullText) {
        talk(fullText);
      }
    } catch (error) {
      console.error(`Error: ${error}`);
      onError(String(error));
      queue = ""; // 出错就别再吐剩余字符了
    } finally {
      // 标记流结束；定时器会把队列里剩余字符吐完后再清理、解除 loading
      streamDone = true;
    }
  };

  onSearchRef.current = onSearch;

  useEffect(() => {
    if (!listening && Boolean(transcript)) {
      // 用户说完、开始解析这句话时，把按钮从 "Recording..." 切回 "Click to record"
      setIsRecording(false);
      (async () => {
        await onSearchRef.current?.(transcript);
      })(); // IIFE
    }
  }, [listening, transcript]);

  const handleChange = (e) => {
    // Update searchValue state when the user types in the input box
    setSearchValue(e.target.value);
  };

  return (
    <div style={searchContainer}>
      {!isChatModeOn && (
        <Search
          placeholder="input search text"
          enterButton="Ask"
          size="large"
          onSearch={onSearch}
          loading={isLoading}
          value={searchValue} // Control the value
          onChange={handleChange} // Update the value when changed
        />
      )}

      <Button
        type="primary"
        size="large"
        danger={isChatModeOn}
        onClick={chatModeClickHandler}
        style={{ marginLeft: "5px"}}
      >
        Chat Mode: {isChatModeOn ? "ON" : "OFF"}
      </Button>

      {isChatModeOn && (
        <Button
          type="primary"
          icon={<AudioOutlined />}
          size="large"
          danger={isRecording}
          onClick={recordingClickHandler}
          style={{ marginLeft: "5px" }}
        >
          {isRecording ? "Recording..." : "Click to record"}
        </Button>
      )}
    </div>
  );
};

export default ChatComponent;
