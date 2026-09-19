"""Embed requested pictures into cloned template slides, leaving shared parts intact."""

from pathlib import Path
import hashlib
import zipfile
from xml.etree import ElementTree as ET

from pptx_transitions import parse_source_xml, serialize_source_xml
from template_fill_pptx.ooxml import NS, CT_NS, REL_NS, _parse_slide_refs, _qn, _xml_bytes
from svg_finalize.fix_image_aspect import get_image_dimensions_basic


def embed_slide_images(output: Path, slides: list[dict], plan: dict, library: dict) -> None:
    if not any(slide.get("imagePath") for slide in slides):
        return
    with zipfile.ZipFile(output) as package:
        entries = {name: package.read(name) for name in package.namelist()}
        refs = _parse_slide_refs(package)
    content_types = ET.fromstring(entries["[Content_Types].xml"])
    sources = {slide["slide_index"]: slide for slide in library["slides"]}
    for index, requested in enumerate(slides):
        if not requested.get("imagePath"):
            continue
        image = Path(requested["imagePath"])
        extension = image.suffix.lower().lstrip(".")
        if extension not in {"png", "jpg", "jpeg"}:
            raise RuntimeError(f"Template images currently require PNG or JPEG: {image}")
        data = image.read_bytes()
        width, height = get_image_dimensions_basic(str(image))
        if not width or not height:
            raise RuntimeError(f"Cannot read template image dimensions: {image}")
        source = sources[plan["slides"][index]["source_slide"]]
        bodies = [slot for slot in source["slots"] if slot["role"] == "body_candidate"]
        if len(bodies) != 1:
            raise RuntimeError("Template image placement requires one unambiguous body frame; no generic template was substituted")
        slot = bodies[0]
        ref = refs[index]
        original = entries[ref.part_name]
        root = parse_source_xml(original)
        tree = root.find("p:cSld/p:spTree", NS)
        shape_id = slot["slot_id"].split("_sh", 1)[1]
        body = next((shape for shape in tree.findall("p:sp", NS)
                     if (node := shape.find("p:nvSpPr/p:cNvPr", NS)) is not None
                     and node.get("id") == shape_id), None)
        if body is None:
            raise RuntimeError("Cannot place a picture in a grouped or inherited template body frame")
        geometry = slot["geometry"]
        x, y, box_w, box_h = [round(float(geometry[key]) * 9525) for key in ("x", "y", "width", "height")]
        if min(box_w, box_h) <= 0:
            raise RuntimeError("Template body has invalid dimensions")
        # Share the existing content frame, not the template's logo/header area.
        if requested.get("content") or requested.get("bullets"):
            text_w = round(box_w * 0.43)
            transform = body.find("p:spPr/a:xfrm", NS)
            if transform is None or transform.find("a:ext", NS) is None:
                raise RuntimeError("Template body has no explicit editable frame")
            transform.find("a:ext", NS).set("cx", str(text_w))
            body_pr = body.find("p:txBody/a:bodyPr", NS)
            if body_pr is not None:
                for child in list(body_pr):
                    if child.tag in {_qn(NS["a"], name) for name in ("noAutofit", "spAutoFit", "normAutofit")}:
                        body_pr.remove(child)
                ET.SubElement(body_pr, _qn(NS["a"], "normAutofit"))
            gap = round(box_w * 0.04)
            x += text_w + gap
            box_w -= text_w + gap
        scale = min(box_w / width, box_h / height)
        pic_w, pic_h = round(width * scale), round(height * scale)
        x += (box_w - pic_w) // 2
        y += (box_h - pic_h) // 2
        media = f"ppt/media/neoworker-{hashlib.sha256(data).hexdigest()}.{extension}"
        entries[media] = data
        rels = ET.fromstring(entries[ref.rels_name])
        rid = "rIdNeoWorkerImage"
        while any(rel.get("Id") == rid for rel in rels):
            rid += "X"
        ET.SubElement(rels, _qn(REL_NS, "Relationship"), {
            "Id": rid, "Type": NS["r"] + "/image", "Target": "../media/" + Path(media).name,
        })
        new_id = max(int(node.get("id", "0")) for node in tree.findall(".//p:cNvPr", NS)) + 1
        pic = ET.Element(_qn(NS["p"], "pic"))
        nv = ET.SubElement(pic, _qn(NS["p"], "nvPicPr"))
        ET.SubElement(nv, _qn(NS["p"], "cNvPr"), {"id": str(new_id), "name": f"Source image {index + 1}"})
        locks = ET.SubElement(nv, _qn(NS["p"], "cNvPicPr"))
        ET.SubElement(locks, _qn(NS["a"], "picLocks"), {"noChangeAspect": "1"})
        ET.SubElement(nv, _qn(NS["p"], "nvPr"))
        fill = ET.SubElement(pic, _qn(NS["p"], "blipFill"))
        ET.SubElement(fill, _qn(NS["a"], "blip"), {_qn(NS["r"], "embed"): rid})
        ET.SubElement(ET.SubElement(fill, _qn(NS["a"], "stretch")), _qn(NS["a"], "fillRect"))
        props = ET.SubElement(pic, _qn(NS["p"], "spPr"))
        transform = ET.SubElement(props, _qn(NS["a"], "xfrm"))
        ET.SubElement(transform, _qn(NS["a"], "off"), {"x": str(x), "y": str(y)})
        ET.SubElement(transform, _qn(NS["a"], "ext"), {"cx": str(pic_w), "cy": str(pic_h)})
        ET.SubElement(ET.SubElement(props, _qn(NS["a"], "prstGeom"), {"prst": "rect"}), _qn(NS["a"], "avLst"))
        extension_list = tree.find("p:extLst", NS)
        tree.insert(list(tree).index(extension_list) if extension_list is not None else len(tree), pic)
        entries[ref.part_name] = serialize_source_xml(root, original)
        entries[ref.rels_name] = _xml_bytes(rels)
        if not any(node.get("Extension") == extension for node in content_types):
            ET.SubElement(content_types, _qn(CT_NS, "Default"), {
                "Extension": extension, "ContentType": "image/png" if extension == "png" else "image/jpeg",
            })
    entries["[Content_Types].xml"] = _xml_bytes(content_types)
    staged = output.with_suffix(".images.tmp")
    try:
        with zipfile.ZipFile(staged, "w", zipfile.ZIP_DEFLATED) as package:
            for name, data in entries.items():
                package.writestr(name, data)
        staged.replace(output)
    finally:
        staged.unlink(missing_ok=True)
