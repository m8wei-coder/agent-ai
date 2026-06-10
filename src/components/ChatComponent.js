import React, { useState } from "react"; // Import useState
import { Input } from "antd";

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

  const onSearch = async (question) => {
    // 正在请求中或问题为空时直接忽略，防止反复点击/回车并发提交
    if (isLoading || !question.trim()) return;

    // Clear the search input
    setSearchValue("");
    setIsLoading(true);
    onStart(question); // 先放一条空气泡，后续逐 token 填充

    try {
      const response = await fetch(
        `${DOMAIN}/chat?question=${encodeURIComponent(question)}`
      );
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

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
          if (data.delta) onDelta(data.delta);
          else if (data.error) onError(data.error);
        }
      }
    } catch (error) {
      console.error(`Error: ${error}`);
      onError(String(error));
    } finally {
      setIsLoading(false);
    }
  };

  const handleChange = (e) => {
    // Update searchValue state when the user types in the input box
    setSearchValue(e.target.value);
  };

  return (
    <div style={searchContainer}>
      <Search
        placeholder="input search text"
        enterButton="Ask"
        size="large"
        onSearch={onSearch}
        loading={isLoading}
        value={searchValue} // Control the value
        onChange={handleChange} // Update the value when changed
      />
    </div>
  );
};

export default ChatComponent;