import React from "react";
import axios from "axios"; // Import axios for HTTP requests
import { InboxOutlined } from "@ant-design/icons";
import { message, Upload } from "antd";

const { Dragger } = Upload;

const DOMAIN = "http://localhost:5001";

const uploadToBackend = async (file) => {
    const formData = new FormData();
    formData.append("file", file);

    try{
        const response = await axios.post(`${DOMAIN}/upload`, formData, {
            headers: {
                "Content-Type": "multipart/form-data",
            },
        });
        message.success("Upload successful.");
        return response;
    } catch (error) {
        console.error(`Error: ${error}`);
        return null;
    }
};

const attributes = {
    name: "file",
    multiple: true,
    //TODO: 同时上传多个文件
    customRequest: async ({ file, onSuccess, onError }) => {
        const response = await uploadToBackend(file);
        if (response && response.status === 200) {
            onSuccess(response.data);
        } else {
            onError(new Error("Upload failed"));
        }
    },
    onChange(info) {
        console.log(info);
    },
    onDrop(e) {
        console.log("Dropped files", e.dataTransfer.files);
    },
};

const PdfUploader = () => {
    return (
        <Dragger {...attributes}>
            <p className="ant-upload-drag-icon">
                <InboxOutlined />
                <p>click or drag file to this area to upload</p>
            </p>
        </Dragger>
    );
};

export default PdfUploader;